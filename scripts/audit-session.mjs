import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ProgressiveTools from '../lib/index.js'

const sessionPath = process.argv[2]
if (sessionPath === undefined) {
  throw new Error('usage: pnpm audit:session <session.jsonl | -> [native | stable-proxy]')
}

let input
if (sessionPath === '-') {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  input = Buffer.concat(chunks).toString('utf8')
} else input = await readFile(sessionPath, 'utf8')
const events = input
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
const mode = process.argv[3] ?? 'native'
await ctx.plugin(ProgressiveTools, { mode })

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
const projectedEstimatedTokens = estimateTokens(assembled.tools)

process.stdout.write(`${JSON.stringify({
  mode,
  estimateOnly: 'Schema characters / 4; excludes model tokenizer, system, history, and cache pricing',
  originalToolCount: originalTools.length,
  projectedToolCount: assembled.tools.length,
  projectedTools: assembled.tools.map(tool => tool.name).sort(),
  originalEstimatedTokens,
  projectedEstimatedTokens,
  reductionPercent: Number((
    (1 - projectedEstimatedTokens / originalEstimatedTokens) * 100
  ).toFixed(1)),
}, undefined, 2)}\n`)
