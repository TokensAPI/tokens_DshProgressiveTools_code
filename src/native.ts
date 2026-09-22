import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, renderToolsSdk, renderToolsSdkPy } from '@deepseek-ai/dsh-tools'
import type { JsonValue, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { buildCatalog, matchesToolName, searchTools } from './catalog.js'
import type { ResolvedConfig } from './types.js'

const PROTOCOL = 'dsh-progressive-tools/native-v1'
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function parse(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) as unknown } catch { return undefined }
}

function loadedNames(value: unknown): string[] {
  if (!record(value) || value.protocol !== PROTOCOL) return []
  const names = value.allLoadedTools ?? value.loadedTools
  return Array.isArray(names) && names.every(name => typeof name === 'string') ? names : []
}

function contentValue(content: unknown): unknown {
  if (!Array.isArray(content)) return undefined
  const text = content.find(part => record(part) && part.type === 'text')
  return record(text) ? parse(text.text) : undefined
}

/** Only discovery changes model visibility; execution and result presentation stay host-owned. */
export function applyNativeDiscovery(ctx: Context, config: ResolvedConfig): void {
  const states = new WeakMap<Agent, Set<string>>()
  const nativeParents = new Set<ToolExecutionToken>()
  const eager = (name: string) => name === config.toolName || name === 'run_code'
    || matchesToolName(name, config.alwaysVisible)
  const catalogFor = (agent: Agent) => buildCatalog(
    agent.ctx.tools.schemas(agent).filter(schema => !eager(schema.name)),
    config.groups, config.charactersPerToken,
  )

  const bindSkill = (agent: Agent, loaded: Set<string>, args: unknown) => {
    const value = parse(args)
    if (!record(value)) return
    const binding = config.skillBindings.find(item => item.skill === (value.name ?? value.skill))
    if (!binding) return
    const catalog = catalogFor(agent)
    for (const group of binding.groups) {
      for (const tool of catalog.groups.get(group)?.tools ?? []) loaded.add(tool.name)
    }
  }

  const stateFor = (agent: Agent): Set<string> => {
    const existing = states.get(agent)
    if (existing) return existing
    const loaded = new Set<string>()
    states.set(agent, loaded)
    const session = agent.session as unknown as {
      events?: readonly unknown[]; snapshotEvents?: () => readonly unknown[]
    }
    const calls = new Map<string, { name: string; args: unknown }>()
    for (const event of session.snapshotEvents?.() ?? session.events ?? []) {
      if (!record(event) || !record(event.data)) continue
      const data = event.data
      if (event.type === 'tool/call' && typeof data.callId === 'string' && typeof data.name === 'string') {
        calls.set(data.callId, { name: data.name, args: data.arguments })
      } else if (event.type === 'tool/result' && record(data.message)) {
        const message = data.message
        const source = record(message.source) ? message.source : undefined
        const call = calls.get(String(source?.callId))
        const block = Array.isArray(message.content) ? message.content[0] : undefined
        if (!record(block) || block.type !== 'tool-result' || block.isError === true) continue
        // A result-only history window can restore our versioned presentation snapshot.
        if (call?.name === config.toolName || (!call && record(data.meta) && data.meta.protocol === PROTOCOL)) {
          for (const name of loadedNames(data.meta).concat(loadedNames(contentValue(block.content)))) loaded.add(name)
        } else if (call?.name === 'skill') bindSkill(agent, loaded, call.args)
      } else if (event.type === 'tool/code-dispatch' && data.isError === false) {
        if (data.name === config.toolName) {
          for (const name of loadedNames(contentValue(data.content))) loaded.add(name)
        } else if (data.name === 'skill') bindSkill(agent, loaded, data.arguments)
      }
    }
    return loaded
  }

  ctx.tools.register(defineTool({
    name: config.toolName,
    description: 'Find and load tools for direct native calls. Search descriptions, exact names, or configured multilingual aliases. Use status to browse; use load with exact names to recover from a search miss. Loading does not execute a tool.',
    parameters: {
      action: { type: 'string', enum: ['search', 'status', 'load'], description: 'Defaults to search. Status only browses; search and load expose complete definitions on the next model request.' },
      query: { type: 'string', description: 'Capability, service, exact tool name, or alias. If terminology differs, try another language or browse status.' },
      names: { type: 'array', items: { type: 'string' }, description: 'Exact tool names for action load. Load only the tools needed for this task.' },
      offset: { type: 'integer', description: 'Zero-based offset for paginated search or status, default 0.' },
      max_results: { type: 'integer', description: `Page size, at most ${config.maxResults}.` },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const rendered = { ...value }
        delete rendered.allLoadedTools
        return [{ type: 'text', text: JSON.stringify(rendered) }]
      },
      presentationMeta: (_args, value) => ({ protocol: PROTOCOL, allLoadedTools: value.allLoadedTools ?? [] }),
    },
    // Serialize host-scheduled discovery so durable cumulative snapshots do not
    // race; loaded business tools retain their original concurrency classifiers.
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (!exec.agent) throw new Error('Tool discovery requires an agent-scoped execution')
      const catalog = catalogFor(exec.agent)
      const loaded = stateFor(exec.agent)
      const action = args.action ?? 'search'
      const offset = args.offset ?? 0
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer')
      const limit = Math.min(config.maxResults, Math.max(1, args.max_results ?? config.maxResults))
      const query = args.query?.trim() ?? ''
      if (action === 'search' && !query) throw new Error('query is required for search')
      const ranked = action === 'search'
        ? catalog.tools.has(query) ? [query] : searchTools(catalog, query, catalog.tools.size).map(match => match.name)
        : [...catalog.tools.keys()].sort()
      let selected = ranked.slice(offset, offset + limit)
      if (action === 'load') {
        if (!args.names?.length || args.names.length > 32) throw new Error('load requires between 1 and 32 exact names')
        selected = [...new Set(args.names)]
        const available = new Set(exec.agent.ctx.tools.schemas(exec.agent).map(schema => schema.name))
        const missing = selected.filter(name => !available.has(name))
        if (missing.length) throw new Error(`Tools not available in this scope: ${missing.join(', ')}. Browse status for available names.`)
      }
      const toLoad = action === 'status' ? [] : selected
      const allLoadedTools = [...new Set([...loaded, ...toLoad])].sort()
      // Full schemas arrive through the host's tools field, not a second copy in history.
      const tools = selected.map(name => {
        const tool = exec.agent!.ctx.tools.get(name, exec.agent)
        return { name, description: (tool?.description ?? '').slice(0, 240), group: catalog.toolToGroup.get(name) ?? name }
      })
      return {
        protocol: PROTOCOL, action, tools,
        loadedTools: toLoad.filter(name => !loaded.has(name)), allLoadedTools,
        total: action === 'load' ? selected.length : ranked.length,
        nextOffset: action !== 'load' && offset + limit < ranked.length ? offset + limit : null,
        instruction: action === 'status'
          ? 'Browse further with nextOffset, or load exact names. Browsing does not activate tools.'
          : toLoad.length ? 'Call the loaded tools directly using their complete native definitions on the next request.'
            : 'No search match is not proof of missing capability. Browse status, use exact names, or retry different keywords.',
      }
    },
  }))

  ctx.systemPrompt.section({
    name: 'tokens-progressive-tools:discovery', order: 140,
    text: `Only common and previously loaded tools are listed. Use ${config.toolName} to search or browse other capabilities, then call loaded tools directly. A search miss does not mean a capability is unavailable. Load tools before calling them; do not combine discovery and a new target call in the same parallel batch.`,
  })
  ctx.systemPrompt.section({
    name: 'tokens-progressive-tools:catalog', order: 141,
    text: ({ agent }) => {
      if (!agent) return ''
      const groups = [...catalogFor(agent).groups.values()].sort((a, b) => a.id.localeCompare(b.id))
      return `Available capability directory (first ${Math.min(24, groups.length)} of ${groups.length}; browse ${config.toolName} status for all tools):\n`
        + groups.slice(0, 24).map(group => `${group.id}: ${group.description.slice(0, 120)} (${group.tools.length} tools)`).join('\n')
    },
  })

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const resolved = await next()
    if (!context.agent) return resolved
    const agent = context.agent
    const loaded = stateFor(agent)
    const visible = (name: string) => eager(name) || loaded.has(name)
    const hidden = agent.ctx.tools.schemas(agent).filter(schema => !visible(schema.name)).map(schema => schema.name)
    const sections = resolved.sections.filter(section => !config.deferToolGuidance
      || !hidden.some(name => section.name === `tool:${name}` || section.name.startsWith(`tool:${name}:`)))
      .map(section => {
        if (section.name !== 'tools:sdk') return section
        const schemas = agent.ctx.tools.schemas(agent).filter(schema => visible(schema.name) && schema.name !== 'run_code')
          .map(schema => ({ ...schema, output: agent.ctx.tools.get(schema.name, agent)!.output.schema }))
        return { ...section, text: section.text.includes('```python') ? renderToolsSdkPy(schemas) : renderToolsSdk(schemas) }
      })
    return { ...resolved, sections, tools: resolved.tools.filter(schema => visible(schema.name)) }
  }, { prepend: true })

  ctx.tools.guard(exec => {
    if (!exec.agent) return undefined
    if ((exec.parent !== undefined && nativeParents.has(exec.parent))
      || eager(exec.name) || stateFor(exec.agent).has(exec.name)) {
      // Loaded tools retain internal composition; the generic code transport
      // must still load each target instead of granting access to all tools.
      if (exec.name !== 'run_code') nativeParents.add(exec.token)
      return undefined
    }
    return `Tool ${JSON.stringify(exec.name)} is not loaded. Use ${config.toolName} with action load and its exact name, then call it directly.`
  })
  ctx.on('tools/result', (exec, result) => {
    nativeParents.delete(exec.token)
    if (!exec.agent || result.isError) return
    const loaded = stateFor(exec.agent)
    if (exec.name === config.toolName) {
      for (const name of loadedNames(result.value as JsonValue)) loaded.add(name)
    } else if (exec.name === 'skill') bindSkill(exec.agent, loaded, exec.arguments)
  })
  ctx.on('agent/session-start', ({ agent }) => { stateFor(agent) })
  ctx.on('agent/disposed', ({ agent }) => { states.delete(agent) })
  ctx.effect(() => () => { nativeParents.clear() })
}
