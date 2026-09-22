import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { CallId, createToolResultMessage, createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import * as Plugin from '../src/index.js'

const signal = new AbortController().signal
const fixture = (name: string, description = `${name} fixture`) => defineTool({
  name, description, parameters: { item: { type: 'string', required: true } },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }],
    presentationMeta: (args) => ({ item: args.item }) },
  execute: async args => args.item,
})

async function setup(definitions: ToolDefinition[] = [], config: Plugin.Config = {}, history?: Session) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  for (const definition of definitions) ctx.tools.register(definition)
  const plugin = ctx.plugin(Plugin, config)
  await plugin
  const agent = {} as Agent
  await ctx.plugin(Object.assign((inner: Context) => {
    const scope = createScope(inner, agent)
    Object.assign(agent, { ctx: scope.ctx, session: history ?? Session.create(SessionId('native-test')) })
  }, { inject: ['tools', 'systemPrompt'] }))
  let sequence = 0
  const call = (name: string, args: unknown, abortSignal = signal) => ctx.tools.execute({
    name, arguments: args, agent, signal: abortSignal, callId: CallId(`call-${++sequence}`),
  })
  const assemble = () => ctx.systemPrompt.assemble({ agent, scope: agent, signal })
  return { ctx, agent, plugin, call, assemble }
}

describe('native discovery contract', () => {
  it('loads only the exact name even when sibling names and descriptions also match', async () => {
    const { call, assemble } = await setup([fixture('vendor_open'), fixture('vendor_open_other', 'Use vendor_open for related operations')])
    await call('tool_search', { query: 'vendor_open' })
    expect((await assemble()).tools.map(t => t.name)).toEqual(['tool_search', 'vendor_open'])
  })

  it('does not commit discovery when host result policy turns the search into an error', async () => {
    const { ctx, call, assemble } = await setup([fixture('vendor_open')])
    ctx.on('tools/post-execute', async (exec, _result, next) => {
      const result = await next()
      return exec.name === 'tool_search' ? { kind: 'block', feedback: [{ type: 'text', text: 'result denied' }] } : result
    })
    expect((await call('tool_search', { query: 'vendor_open' })).isError).toBe(true)
    expect((await assemble()).tools.map(t => t.name)).toEqual(['tool_search'])
  })

  it('is the default and exposes only matched complete definitions, preserving native identity', async () => {
    const { ctx, call, assemble } = await setup([fixture('archive_open'), fixture('archive_delete'), fixture('read')], { maxResults: 1 })
    expect(Plugin.resolveConfig({}).mode).toBe('native')
    const first = await assemble()
    expect(first.tools.map(t => t.name)).toEqual(['read', 'tool_search'])
    expect(first.sections.map(s => s.text).join('\n')).toContain('archive')
    expect((await call('archive_open', { item: 'a' })).isError).toBe(true)
    await call('tool_search', { query: 'archive_open' })
    const second = await assemble()
    expect(second.tools.map(t => t.name)).toEqual(['archive_open', 'read', 'tool_search'])
    expect(second.tools[0]?.parameters).toEqual(ctx.tools.get('archive_open')?.parameters)
    const seen: string[] = []
    ctx.on('tools/pre-execute', async (exec, next) => { seen.push(exec.name); return next() })
    expect(await call('archive_open', { item: 'a' })).toMatchObject({ isError: false, value: 'a', meta: { item: 'a' } })
    expect(seen).toEqual(['archive_open'])
    expect((await call('archive_delete', { item: 'a' })).isError).toBe(true)
  })

  it('keeps exact names recoverable beyond ranked page limits and does not activate status results', async () => {
    const { call, assemble } = await setup(Array.from({ length: 9 }, (_, i) => fixture(`vendor_operation_${i}`)), { maxResults: 2 })
    const miss = await call('tool_search', { query: 'unrelated-xyz' })
    expect(miss).toMatchObject({ value: { tools: [], instruction: expect.stringContaining('not proof') } })
    const names: string[] = []
    for (let offset = 0; offset < 9; offset += 2) {
      const result = await call('tool_search', { action: 'status', offset })
      const value = result.value as { tools: { name: string }[] }
      names.push(...value.tools.map(tool => tool.name))
    }
    expect(new Set(names).size).toBe(9)
    expect((await assemble()).tools).toHaveLength(1)
    expect((await call('tool_search', { action: 'load', names: [names[8]] })).isError).toBe(false)
    expect((await call(names[8]!, { item: 'ok' })).isError).toBe(false)
    expect((await call('tool_search', { action: 'load', names: ['missing'] })).isError).toBe(true)
  })

  it('searches multilingual configured metadata without tool-specific code', async () => {
    const { call, assemble } = await setup([fixture('vendor_alpha')], {
      groups: [{ id: 'records', description: 'Record operations', aliases: ['客户资料'], include: ['vendor_*'] }],
    })
    expect((await call('tool_search', { query: '客户资料' })).isError).toBe(false)
    expect((await assemble()).tools.map(t => t.name)).toContain('vendor_alpha')
  })

  it('retains loaded tools, restores guidance and SDK, and respects external restrictions', async () => {
    const { ctx, agent, call, assemble } = await setup([fixture('vendor_alpha'), fixture('vendor_beta')], { retentionTurns: 1 })
    ctx.systemPrompt.section({ name: 'tool:vendor_alpha:requirements', order: 145, text: 'Explicit confirmation is required.' })
    ctx.systemPrompt.section({ name: 'tools:sdk', order: 146, text: '```typescript\nplaceholder\n```' })
    expect((await assemble()).sections.some(s => s.name === 'tool:vendor_alpha:requirements')).toBe(false)
    await call('tool_search', { action: 'load', names: ['vendor_alpha'] })
    agent.session.append('turn/start', { turn: 100 })
    const assembled = await assemble()
    expect(assembled.sections.some(s => s.name === 'tool:vendor_alpha:requirements')).toBe(true)
    expect(assembled.sections.find(s => s.name === 'tools:sdk')?.text).toContain('vendor_alpha')
    expect(assembled.sections.find(s => s.name === 'tools:sdk')?.text).not.toContain('vendor_beta')
    const release = agent.ctx.tools.restrict({ allow: ['tool_search'] })
    expect((await assemble()).tools.map(t => t.name)).not.toContain('vendor_alpha')
    expect((await call('vendor_alpha', { item: 'a' })).isError).toBe(true)
    release()
    expect((await call('vendor_alpha', { item: 'a' })).isError).toBe(false)
  })

  it('does not alter rich content, presentation, contexts, or conclusion', async () => {
    const content = [
      { type: 'text', text: 'A durable artifact' },
      { type: 'image', attachment: { attachmentId: 'opaque-image', mediaType: 'image/png', bytes: 99, width: 2, height: 2 } },
    ] as ContentBlock[]
    const extra = createUserMessage({ source: { kind: 'plugin', plugin: 'fixture' }, content: [{ type: 'text', text: 'follow-up context' }] })
    const definition = defineTool({
      name: 'vendor_artifact', description: 'Create an artifact', parameters: {},
      output: { schema: { type: 'string' }, render: () => content, presentationMeta: () => ({ artifact: 'opaque' }) },
      presentCall: () => ({ card: 'generic', title: 'Artifact' }),
      isConcurrencySafe: () => true,
      execute: async (_args, exec) => { exec.deferContext(extra); exec.concludeTurn(); return 'created' },
    })
    const { ctx, call } = await setup([definition])
    await call('tool_search', { action: 'load', names: ['vendor_artifact'] })
    expect(ctx.tools.get('vendor_artifact')).toBe(definition)
    expect(await call('vendor_artifact', {})).toMatchObject({
      isError: false, value: 'created', content, meta: { artifact: 'opaque' }, additionalContexts: [extra], concludesTurn: true,
    })
  })

  it('preserves validation, host denial, errors, and cancellation without running rejected bodies', async () => {
    let runs = 0
    const broken = defineTool({
      name: 'vendor_broken', description: 'A failing operation',
      parameters: { item: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => { runs++; throw new HarnessError('fixture failure', 'FIXTURE_ERROR') },
    })
    const { ctx, call } = await setup([broken])
    await call('tool_search', { action: 'load', names: ['vendor_broken'] })
    expect((await call('vendor_broken', {})).isError).toBe(true)
    expect(runs).toBe(0)
    expect(await call('vendor_broken', { item: 'a' })).toMatchObject({ isError: true, error: { info: { code: 'FIXTURE_ERROR' } } })
    const controller = new AbortController()
    controller.abort()
    expect((await call('vendor_broken', { item: 'a' }, controller.signal)).isError).toBe(true)
    const release = ctx.tools.guard(exec => exec.name === 'vendor_broken' ? 'host policy denied' : undefined)
    expect((await call('vendor_broken', { item: 'a' })).isError).toBe(true)
    expect(runs).toBe(1)
    release()
  })

  it('restores a result-only snapshot and nested search increments without accepting unrelated results', async () => {
    const source = Session.create(SessionId('replay'))
    source.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId: CallId('old'), isError: false, content: [{ type: 'text', text: '{}' }] }),
      meta: { protocol: 'dsh-progressive-tools/native-v1', allLoadedTools: ['vendor_alpha'] },
    }, { surfaceOp: 'append' })
    source.append('tool/code-dispatch', {
      rootCallId: CallId('root'), parentCallId: CallId('root'), subCallId: CallId('search'), name: 'tool_search', arguments: {}, isError: false,
      content: [{ type: 'text', text: JSON.stringify({ protocol: 'dsh-progressive-tools/native-v1', loadedTools: ['vendor_beta'] }) }],
    })
    const snapshot = { snapshotEvents: () => source.events } as unknown as Session
    const { assemble } = await setup([fixture('vendor_alpha'), fixture('vendor_beta'), fixture('vendor_other')], {}, snapshot)
    expect((await assemble()).tools.map(t => t.name)).toEqual(['tool_search', 'vendor_alpha', 'vendor_beta'])
  })

  it('unions simultaneous discovery, survives reconnect, isolates agents, and unloads cleanly', async () => {
    const { ctx, agent, plugin, call, assemble } = await setup([fixture('vendor_alpha')])
    let dispose = ctx.tools.register(fixture('vendor_beta'))
    await Promise.all(['vendor_alpha', 'vendor_beta'].map(name => call('tool_search', { action: 'load', names: [name] })))
    expect((await assemble()).tools).toHaveLength(3)
    dispose()
    expect((await assemble()).tools).toHaveLength(2)
    dispose = ctx.tools.register(fixture('vendor_beta'))
    expect((await assemble()).tools).toHaveLength(3)
    const other = { ctx: agent.ctx, session: Session.create(SessionId('other')) } as Agent
    expect((await ctx.systemPrompt.assemble({ scope: other, agent: other, signal })).tools.map(t => t.name)).toEqual(['tool_search'])
    await plugin.dispose()
    expect((await assemble()).tools.map(t => t.name)).toEqual(['vendor_alpha', 'vendor_beta'])
    dispose()
  })

  it('allows loaded tools to compose internally while denying unloaded root calls', async () => {
    const composed = (name: string) => defineTool({
      name, description: name, parameters: {},
      output: { schema: { type: 'boolean' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      execute: async (_args, exec) => {
        const result = await exec.agent!.ctx.tools.execute({
          agent: exec.agent!, name: 'vendor_internal', arguments: { item: 'ok' }, signal: exec.signal,
          callId: CallId(`${exec.callId}:child`), parent: exec.token, rootCallId: exec.rootCallId,
        })
        return !result.isError
      },
    })
    const { call } = await setup([composed('vendor_composite'), fixture('vendor_internal')])
    expect((await call('vendor_internal', { item: 'ok' })).isError).toBe(true)
    await call('tool_search', { action: 'load', names: ['vendor_composite'] })
    expect(await call('vendor_composite', {})).toMatchObject({ value: true })
  })
})
