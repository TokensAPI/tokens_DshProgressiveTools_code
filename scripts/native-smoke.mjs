/**
 * Run the compiled plugin against a host's complete installed dependency graph.
 *
 * `DSH_TEST_RUNTIME` selects the host, so the same script runs on DSH 0.1 and
 * DSH 0.2. Every name the two runtimes spell differently is read off the host
 * rather than assumed, so a further rename fails here instead of silently
 * degrading discovery in a release.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { emitAgentEvent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { KNOWN_SESSION_EVENT_TYPES, Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'

const Plugin = await import(process.env.DSH_TEST_PLUGIN
  ? pathToFileURL(resolve(process.env.DSH_TEST_PLUGIN)).href
  : new URL('../lib/index.js', import.meta.url).href)
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const PROTOCOL = 'dsh-progressive-tools/native-v1'
const signal = new AbortController().signal
const artifact = defineTool({
  name: 'vendor_artifact', description: 'Create an artifact', parameters: { title: { type: 'string', required: true } },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [
      { type: 'text', text: value },
      { type: 'image', attachment: { attachmentId: 'opaque-test', mediaType: 'image/png', bytes: 100, width: 2, height: 2 } },
    ],
    presentationMeta: args => ({ title: args.title }),
  },
  execute: async args => args.title,
})

async function host(config = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  ctx.tools.register(artifact)
  await ctx.plugin(Plugin, config)
  return ctx
}

/** Enter one agent scope on the given session, the way the host's factory composes it. */
async function enter(ctx, session) {
  const agent = {}
  await ctx.plugin(Object.assign(inner => {
    const scope = createScope(inner, agent)
    Object.assign(agent, { ctx: scope.ctx, session })
  }, { inject: ['tools', 'systemPrompt'] }))
  return agent
}

const assemble = (ctx, agent) => ctx.systemPrompt.assemble({ scope: agent, agent, signal })
const names = assembly => assembly.tools.map(tool => tool.name)
const call = (ctx, agent, name, args) =>
  ctx.tools.execute({ agent, signal, name, arguments: args, callId: `${name}:${Math.random()}` })

// Discovery, execution, and presentation on a fresh session.
const ctx = await host()
const agent = await enter(ctx, Session.create(SessionId('native-smoke')))
assert.deepEqual(names(await assemble(ctx, agent)), ['tool_search'])
assert.equal((await call(ctx, agent, 'tool_search', { query: 'vendor_artifact' })).isError, false)
assert.deepEqual(names(await assemble(ctx, agent)), ['tool_search', 'vendor_artifact'])
assert.equal((await call(ctx, agent, 'vendor_artifact', {})).isError, true)
const result = await call(ctx, agent, 'vendor_artifact', { title: 'ok' })
assert.equal(result.isError, false)
assert.equal(result.content[1].type, 'image')
assert.deepEqual(result.meta, { title: 'ok' })

// The host's own compatibility gate, which decides at startup whether this
// plugin loads at all. Only hosts that ship the boot package can answer.
let compatibility = 'skipped: host does not expose its compatibility gate'
try {
  const boot = await import('@deepseek-ai/dsh-app-boot')
  const runtimeVersion = boot.getDshRuntimeVersion()
  const issue = boot.evaluatePluginCompatibility(manifest)
  assert.equal(issue, undefined, `peerDependencies reject dsh ${runtimeVersion}: ${JSON.stringify(issue?.peers)}`)
  compatibility = `accepted by dsh ${runtimeVersion}`
} catch (error) {
  if (error instanceof assert.AssertionError) throw error
}

// Discovery performed inside `run_code` is logged under a name the host
// renamed in 0.2; replay has to read whichever name this host actually knows,
// or a resumed session forgets the tools the model already loaded.
const dispatchEvent = ['tool/ptc-dispatch', 'tool/code-dispatch'].find(type => KNOWN_SESSION_EVENT_TYPES.has(type))
assert.ok(dispatchEvent, 'host logs run_code sub-dispatches under an unknown event name')
const replayed = Session.create(SessionId('native-smoke-replay'))
replayed.append(dispatchEvent, {
  rootCallId: 'root', parentCallId: 'root', subCallId: 'root:sub:1', name: 'tool_search', arguments: {}, isError: false,
  content: [{ type: 'text', text: JSON.stringify({ protocol: PROTOCOL, loadedTools: ['vendor_artifact'] }) }],
})
const resumed = await enter(ctx, replayed)
assert.deepEqual(names(await assemble(ctx, resumed)), ['tool_search', 'vendor_artifact'])

// Eager per-agent initialization: the announcement both runtimes emit has to
// reach the plugin through the host's own dispatcher. Dynamic mode makes the
// effect observable, because it installs the restriction right there.
const dynamicCtx = await host({ mode: 'dynamic', groups: [{ id: 'vendor', include: ['vendor_*'], description: 'Vendor tools' }] })
const announced = await enter(dynamicCtx, Session.create(SessionId('native-smoke-announced')))
const visible = () => announced.ctx.tools.schemas(announced).map(schema => schema.name)
assert.ok(visible().includes('vendor_artifact'))
emitAgentEvent(dynamicCtx, announced, 'agent/created', { source: 'startup' })
assert.ok(!visible().includes('vendor_artifact'), 'agent/created did not reach the plugin')

console.log(JSON.stringify({
  passed: true,
  compatibility,
  historyAPI: typeof agent.session.snapshotEvents === 'function' ? 'snapshotEvents' : 'events',
  dispatchEvent,
  nativeName: 'vendor_artifact',
  imageAndMetadataPreserved: true,
}))
