/**
 * The cross-version boundaries declared in `src/host.ts`.
 *
 * One published version serves every runtime the `peerDependencies` range
 * claims, and the host renamed several of the names this plugin reads. These
 * cases lock each boundary from both sides: the plugin must still accept the
 * older spelling, and it must accept the one the installed runtime actually
 * uses. Narrowing `src/host.ts` back to a single spelling fails here.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { KNOWN_SESSION_EVENT_TYPES, Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { isNestedDispatchEvent, loggedToolResultOf } from '../src/host.js'
import * as Plugin from '../src/index.js'

/** Every sub-dispatch log name the plugin claims to replay. 0.1.0 used the first. */
const NESTED_DISPATCH_EVENTS = ['tool/code-dispatch', 'tool/ptc-dispatch'] as const

const signal = new AbortController().signal
const fixture = (name: string) => defineTool({
  name,
  description: `${name} fixture`,
  parameters: {},
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute: async () => `ran:${name}`,
})

/**
 * One sub-dispatch log entry as a host writes it, replayed through a
 * snapshot-only session. A log entry is built directly rather than appended,
 * because a runtime rejects the name the other runtime uses.
 */
function sessionLoggingNestedSearch(type: string, loaded: readonly string[]): Session {
  const events = [{
    type,
    data: {
      rootCallId: 'root',
      parentCallId: 'root',
      subCallId: 'root:sub:1',
      name: 'tool_search',
      arguments: {},
      isError: false,
      content: [{
        type: 'text',
        text: JSON.stringify({ protocol: 'dsh-progressive-tools/native-v1', loadedTools: loaded }),
      }],
    },
  }]
  return { id: SessionId('nested-replay'), snapshotEvents: () => events } as unknown as Session
}

async function setup(session: Session, config: Plugin.Config = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  for (const name of ['vendor_alpha', 'vendor_beta']) ctx.tools.register(fixture(name))
  await ctx.plugin(Plugin, {
    groups: [{ id: 'vendor', include: ['vendor_*'], description: 'Vendor tools' }],
    ...config,
  })
  const agent = {} as Agent
  await ctx.plugin(Object.assign((inner: Context) => {
    const scope = createScope(inner, agent)
    Object.assign(agent, { id: session.id, session, ctx: scope.ctx })
  }, { inject: ['tools', 'systemPrompt'] }))
  return { ctx, agent }
}

const assembled = async (ctx: Context, agent: Agent) =>
  (await ctx.systemPrompt.assemble({ scope: agent, agent, signal })).tools.map(tool => tool.name)

describe('cross-version host contract', () => {
  it.each(NESTED_DISPATCH_EVENTS)('PT-COMPAT-01 replays a sub-dispatch logged as %s', async (type) => {
    const { ctx, agent } = await setup(sessionLoggingNestedSearch(type, ['vendor_beta']))

    expect(await assembled(ctx, agent)).toEqual(['tool_search', 'vendor_beta'])
  })

  it('PT-COMPAT-02 does not replay a sub-dispatch name no runtime uses', async () => {
    const { ctx, agent } = await setup(sessionLoggingNestedSearch('tool/future-dispatch', ['vendor_beta']))

    expect(await assembled(ctx, agent)).toEqual(['tool_search'])
  })

  it('PT-COMPAT-03 replays the sub-dispatch name the installed runtime logs', () => {
    // The installed runtime's own vocabulary decides this, so a further rename
    // upstream fails here instead of silently dropping discovery on resume.
    const known = NESTED_DISPATCH_EVENTS.filter(type => KNOWN_SESSION_EVENT_TYPES.has(type))

    expect(known).not.toEqual([])
    expect(known.every(type => isNestedDispatchEvent(type))).toBe(true)
  })

  it('PT-COMPAT-04 reads a tool result logged under either runtime envelope', async () => {
    // Every 0.1 release wrapped the blocks in one `tool-result` content block
    // carrying `isError`; 0.2 dropped that wrapper and moved `isError` onto a
    // tool-role message. Both shapes are built by hand and asserted separately,
    // so each is exercised whichever runtime the suite runs against.
    const restored = JSON.stringify({ protocol: 'dsh-progressive-tools/native-v1', allLoadedTools: ['vendor_beta'] })
    const blocks = [{ type: 'text', text: restored }]
    const envelopes = {
      'wrapped (every 0.1)': {
        role: 'user',
        source: { kind: 'tool', callId: 'call-1' },
        content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false, content: blocks }],
      },
      'flat (0.2 and later)': {
        role: 'tool',
        source: { kind: 'tool', callId: 'call-1' },
        toolCallId: 'call-1',
        isError: false,
        content: blocks,
      },
    }

    for (const [shape, message] of Object.entries(envelopes)) {
      // The matching call makes restoration come from the envelope's blocks
      // rather than from the event's presentation metadata.
      const events = [
        { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'tool_search', arguments: {} } },
        { type: 'tool/result', data: { turn: 1, step: 1, message } },
      ]
      const session = { id: SessionId('result-replay'), snapshotEvents: () => events } as unknown as Session
      const { ctx, agent } = await setup(session)

      expect(await assembled(ctx, agent), shape).toEqual(['tool_search', 'vendor_beta'])
    }
  })

  it('PT-COMPAT-05 reads the tool-result envelope the installed runtime itself writes', () => {
    // The case above builds both envelopes by hand, so it passes on either
    // runtime whether or not the reader still understands the installed one.
    // Here the shape comes from the runtime's own constructor, so a third
    // envelope upstream fails here instead of silently restoring nothing.
    const blocks = [{ type: 'text' as const, text: JSON.stringify({ protocol: 'dsh-progressive-tools/native-v1', allLoadedTools: ['vendor_beta'] }) }]
    const message = createToolResultMessage({ callId: ToolCallId('call-1'), isError: false, content: blocks })

    const read = loggedToolResultOf(message)

    expect(read?.callId).toBe('call-1')
    expect(read?.isError).toBe(false)
    expect(read?.content).toEqual(blocks)

    // One of the two envelopes in full, never a half-recognized mixture: the
    // wrapper carries `isError` on its block and rides a user-role message,
    // the flat one carries it on a tool-role message.
    const record = message as unknown as Record<string, unknown>
    const content = record.content as Record<string, unknown>[]
    const wrapped = content.length === 1 && content[0]?.type === 'tool-result'

    expect(record.role).toBe(wrapped ? 'user' : 'tool')
    expect(wrapped ? content[0]?.isError : record.isError).toBe(false)
  })

  it('PT-COMPAT-06 reads a legacy session that exposes an events array instead of snapshotEvents', async () => {
    // The 0.1.0 `Session.events` getter is gone from every runtime in use, but
    // a persisted snapshot handed to the plugin may still arrive in that shape.
    const logged = sessionLoggingNestedSearch('tool/ptc-dispatch', ['vendor_beta'])
    const legacy = { id: logged.id, events: logged.snapshotEvents() } as unknown as Session
    const { ctx, agent } = await setup(legacy)

    expect(await assembled(ctx, agent)).toEqual(['tool_search', 'vendor_beta'])
  })

  it('PT-COMPAT-07 initializes agent state on the announcement the installed runtime emits', async () => {
    // 0.2 removed `agent/session-start`; `agent/created` is the per-agent
    // announcement every supported runtime emits. In dynamic mode the effect is
    // observable, because initialization installs the restriction right there.
    const { ctx, agent } = await setup(Session.create(SessionId('created-eager')), { mode: 'dynamic' })
    const visible = () => ctx.tools.schemas(agent).map(schema => schema.name)
    expect(visible()).toContain('vendor_alpha')

    // 0.2 carries the start source on this payload and 0.1 carries nothing;
    // passing it through a variable keeps the emit compilable against both.
    const announcement = { source: 'startup' as const }
    agentEvents(ctx, agent).emit('agent/created', announcement)

    expect(visible()).not.toContain('vendor_alpha')
  })
})
