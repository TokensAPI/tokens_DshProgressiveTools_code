import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
const Plugin = await import(process.env.DSH_TEST_PLUGIN
  ? pathToFileURL(resolve(process.env.DSH_TEST_PLUGIN)).href
  : new URL('../lib/index.js', import.meta.url).href)

const ctx = new Context()
await ctx.plugin(SystemPrompt, {})
await ctx.plugin(ToolRuntime)
ctx.tools.register(defineTool({
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
}))
await ctx.plugin(Plugin, {})
const agent = {}
await ctx.plugin(Object.assign(inner => {
  const scope = createScope(inner, agent)
  Object.assign(agent, { ctx: scope.ctx, session: Session.create(SessionId('native-smoke')) })
}, { inject: ['tools', 'systemPrompt'] }))
const signal = new AbortController().signal
const assemble = () => ctx.systemPrompt.assemble({ scope: agent, agent, signal })
const call = (name, args) => ctx.tools.execute({ agent, signal, name, arguments: args, callId: name })
assert.deepEqual((await assemble()).tools.map(t => t.name), ['tool_search'])
assert.equal((await call('tool_search', { query: 'vendor_artifact' })).isError, false)
assert.deepEqual((await assemble()).tools.map(t => t.name), ['tool_search', 'vendor_artifact'])
assert.equal((await call('vendor_artifact', {})).isError, true)
const result = await call('vendor_artifact', { title: 'ok' })
assert.equal(result.isError, false)
assert.equal(result.content[1].type, 'image')
assert.deepEqual(result.meta, { title: 'ok' })
console.log(JSON.stringify({ passed: true, historyAPI: typeof agent.session.snapshotEvents === 'function' ? 'snapshotEvents' : 'events', nativeName: 'vendor_artifact', imageAndMetadataPreserved: true }))
