import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ProgressiveTools from '../lib/index.js'

const sessionPath = process.argv[2]
if (sessionPath === undefined) {
  throw new Error('usage: pnpm audit:session <session.jsonl>')
}

const events = (await readFile(sessionPath, 'utf8'))
  .split(/\r?\n/)
  .flatMap((line) => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
const request = events.find(event => event?.type === 'request/header')
const originalTools = request?.data?.header?.tools
if (!Array.isArray(originalTools)) {
  throw new Error('session does not contain a request/header tool array')
}

const ctx = new Context()
await ctx.plugin(SystemPrompt, {})
await ctx.plugin(ToolRuntime)
for (const schema of originalTools) {
  ctx.tools.register({
    name: schema.name,
    description: schema.description ?? '',
    parameters: schema.parameters ?? {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async () => 'audit fixture',
  })
}
await ctx.plugin(ProgressiveTools, {})

const session = Session.create(SessionId('tokens-progressive-tools-audit'))
const agent = {}
let scope
await ctx.plugin(Object.assign((inner) => {
  scope = createScope(inner, agent)
}, { inject: ['tools', 'systemPrompt'] }))
Object.assign(agent, { id: session.id, session, ctx: scope.ctx })

const assembled = await ctx.systemPrompt.assemble({
  scope: agent,
  agent,
  signal: new AbortController().signal,
})
const estimateTokens = value => Math.ceil(JSON.stringify(value).length / 4)
const originalEstimatedTokens = estimateTokens(originalTools)
const stableEstimatedTokens = estimateTokens(assembled.tools)

process.stdout.write(`${JSON.stringify({
  originalToolCount: originalTools.length,
  stableToolCount: assembled.tools.length,
  stableTools: assembled.tools.map(tool => tool.name).sort(),
  originalEstimatedTokens,
  stableEstimatedTokens,
  reductionPercent: Number((
    (1 - stableEstimatedTokens / originalEstimatedTokens) * 100
  ).toFixed(1)),
}, undefined, 2)}\n`)
