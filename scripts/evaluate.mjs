import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as Plugin from '../lib/index.js'

const live = process.argv.includes('--live')
const repeats = Number(process.env.EVAL_REPEATS ?? 2)
const tasks = [
  { id: 'lookup', prompt: '查一下订单 ORD-42 的物流状态，只查状态，不要取消订单。', expected: [['parcel_status', { order_id: 'ORD-42' }]], answer: 'DELIVERED' },
  { id: 'dependent', prompt: '查找客户林青的编号，然后查询这个客户的账单总额。', expected: [['ledger_find_customer', { name: '林青' }], ['ledger_invoice_total', { customer_id: 'C-17' }]], answer: '830' },
  { id: 'exact', prompt: '使用 vault_inspect 检查对象 OBJ-7，不要删除或者修改对象。', expected: [['vault_inspect', { object_id: 'OBJ-7' }]], answer: 'VERIFIED' },
  { id: 'artifact', prompt: '生成项目 PRJ-8 的统计图，用返回的附件交付结果。', expected: [['charts_render', { project_id: 'PRJ-8' }]], answer: 'ATTACHMENT_READY' },
]

const specs = [
  ['parcel_status', '查询订单物流状态。Read delivery status; never cancels an order.', 'order_id', 'DELIVERED'],
  ['parcel_cancel', 'Cancel an order. Changes order state.', 'order_id', 'CANCELLED'],
  ['ledger_find_customer', '按姓名查找客户编号。Find customer ID by name.', 'name', 'C-17'],
  ['ledger_invoice_total', '按客户编号查询账单总额。Get invoice total using customer ID, not name.', 'customer_id', '830'],
  ['vault_inspect', 'Read object verification status without modifying it.', 'object_id', 'VERIFIED'],
  ['vault_remove', 'Permanently remove an object.', 'object_id', 'REMOVED'],
  ['charts_render', '生成项目统计图，返回附件。Create a project chart and return an attachment.', 'project_id', 'ATTACHMENT_READY'],
]
const domains = ['calendar', 'warehouse', 'payroll', 'repository', 'travel', 'inventory', 'contacts', 'monitoring']
for (const domain of domains) {
  for (const operation of ['list', 'create', 'inspect', 'update', 'archive', 'export']) {
    specs.push([`${domain}_${operation}`, `${operation} a ${domain} record. Requires an exact record ID. This operation only applies to ${domain}; verify the relevant record exists before use.`, 'record_id', 'UNRELATED'])
  }
}

async function fixture(mode) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  await ctx.plugin(ToolRuntime)
  const executed = []
  for (const [name, description, key, response] of specs) {
    ctx.tools.register(defineTool({
      name, description,
      parameters: { [key]: { type: 'string', required: true, description: `The exact ${key} supplied by the user or returned by a preceding lookup.` } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => name === 'charts_render'
          ? [{ type: 'text', text: value }, { type: 'image', attachment: { attachmentId: 'fixture-chart', mediaType: 'image/png', bytes: 100, width: 2, height: 2 } }]
          : [{ type: 'text', text: value }],
        presentationMeta: () => ({ renderer: name }),
      },
      execute: async args => { executed.push([name, args]); return response },
    }))
  }
  const common = 'Complete the user task with the available tools. Never invent tool outputs or identifiers. Do not perform unrelated operations. Return the requested status or result concisely.'
  ctx.systemPrompt.section({ name: 'evaluation', order: 0, text: common })
  if (mode !== 'full') await ctx.plugin(Plugin, { mode })
  const agent = {}
  await ctx.plugin(Object.assign(inner => {
    Object.assign(agent, { ctx: createScope(inner, agent).ctx, session: Session.create(SessionId(`eval-${mode}`)) })
  }, { inject: ['tools', 'systemPrompt'] }))
  return { ctx, agent, executed }
}

const jsonChars = value => JSON.stringify(value).length
const results = []
const modes = process.argv.includes('--native-only') ? ['native'] : ['full', 'stable-proxy', 'native']
for (let repeat = 0; repeat < (live ? repeats : 1); repeat++) {
  for (const task of tasks) {
    // Rotate order to reduce systematic latency/cache ordering bias.
    for (const mode of [...modes.slice(repeat % 3), ...modes.slice(0, repeat % 3)]) {
      const { ctx, agent, executed } = await fixture(mode)
      const signal = new AbortController().signal
      const messages = [{ role: 'user', content: task.prompt }]
      const stats = { task: task.id, mode, repeat, live, calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, requestChars: 0, firstRequestChars: 0, steps: 0, nativePresentation: true }
      let final = ''
      let finished = false
      const start = performance.now()
      for (let step = 0; step < 9; step++) {
        const assembly = await ctx.systemPrompt.assemble({ scope: agent, agent, signal })
        const system = assembly.sections.map(s => s.text).join('\n\n')
        const tools = assembly.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
        const payload = { model: process.env.EVAL_MODEL, messages: [{ role: 'system', content: system }, ...messages], tools, temperature: 0, max_tokens: 2048 }
        const size = jsonChars(payload)
        stats.requestChars += size
        if (!step) stats.firstRequestChars = size
        stats.steps++
        let toolCalls
        if (live) {
          if (!process.env.EVAL_BASE_URL || !process.env.EVAL_API_KEY || !process.env.EVAL_MODEL) throw new Error('Live evaluation requires EVAL_BASE_URL, EVAL_API_KEY, EVAL_MODEL')
          let response
          for (let attempt = 0; attempt < 4; attempt++) {
            response = await fetch(`${process.env.EVAL_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
              method: 'POST', headers: { Authorization: `Bearer ${process.env.EVAL_API_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(payload), signal: AbortSignal.timeout(60000),
            })
            if (response.status !== 429 || attempt === 3) break
            const waitSeconds = Math.max(15 * (attempt + 1), Number(response.headers.get('retry-after')) || 0)
            console.log(JSON.stringify({ rateLimited: true, waitSeconds }))
            await delay(waitSeconds * 1000)
          }
          if (!response.ok) throw new Error(`Evaluation HTTP ${response.status}; response body withheld`)
          const value = await response.json()
          await delay(1500)
          stats.promptTokens += value.usage?.prompt_tokens ?? 0
          stats.completionTokens += value.usage?.completion_tokens ?? 0
          stats.cachedTokens += value.usage?.prompt_tokens_details?.cached_tokens ?? value.usage?.prompt_cache_hit_tokens ?? 0
          const message = value.choices?.[0]?.message
          if (!message) throw new Error('No evaluation response message')
          messages.push(message)
          final = message.content ?? ''
          toolCalls = message.tool_calls ?? []
          if (!toolCalls.length) { finished = true; break }
        } else {
          // A deterministic transport check, not a measure of model intelligence.
          const target = task.expected[executed.length]
          if (!target) { final = task.answer; finished = true; break }
          const visible = tools.some(t => t.function.name === target[0])
          const name = mode === 'full' || (mode === 'native' && visible) ? target[0]
            : mode === 'stable-proxy' && step % 2 ? 'tool_dispatch' : 'tool_search'
          const args = name === 'tool_search' ? { query: target[0] }
            : name === 'tool_dispatch' ? { name: target[0], arguments: target[1] } : target[1]
          toolCalls = [{ id: `step-${step}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
          messages.push({ role: 'assistant', content: null, tool_calls: toolCalls })
        }
        for (const call of toolCalls) {
          stats.calls++
          let result
          try {
            result = await ctx.tools.execute({ agent, signal, name: call.function.name, arguments: JSON.parse(call.function.arguments), callId: call.id })
          } catch { result = { isError: true, content: [{ type: 'text', text: 'Invalid tool arguments' }] } }
          if (result.isError) stats.errors++
          if (result.content.some(c => c.type === 'image') && (call.function.name !== 'charts_render' || result.meta?.renderer !== 'charts_render')) stats.nativePresentation = false
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result.content) })
        }
      }
      const expectedCalls = task.expected.every(([name, args], i) => executed[i]?.[0] === name && JSON.stringify(executed[i]?.[1]) === JSON.stringify(args))
      // Score tool outcomes and exact argument dependencies, not English marker
      // repetition in a Chinese answer. Presentation is a separate protocol check.
      stats.taskSuccess = expectedCalls && executed.length === task.expected.length && finished && final.trim().length > 0
      stats.contractSuccess = stats.taskSuccess && stats.nativePresentation
      stats.final = final
      stats.executed = executed
      stats.elapsedMs = Math.round(performance.now() - start)
      results.push(stats)
      console.log(JSON.stringify(stats))
      await mkdir('.validation', { recursive: true })
      await writeFile(`.validation/evaluation-${live ? 'live' : 'offline'}${modes.length === 1 ? '-native' : ''}.json`, JSON.stringify({ model: process.env.EVAL_MODEL ?? 'scripted', fixtureTools: specs.length, results }, null, 2))
    }
  }
}
// Optional schema-only audit of an exported real session; no real tool is executed.
if (process.env.EVAL_SESSION_PATH) {
  const events = (await readFile(process.env.EVAL_SESSION_PATH, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  const tools = events.find(e => e.type === 'request/header')?.data?.header?.tools
  console.log(JSON.stringify({ sessionToolCount: tools?.length, sessionToolSchemaChars: jsonChars(tools ?? []) }))
}
