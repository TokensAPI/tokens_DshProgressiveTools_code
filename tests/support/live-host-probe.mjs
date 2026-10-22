/* ============================================================
 * 插进真实宿主里的探针
 * ============================================================
 * 它本身是个 Cordis 插件,作为 profile 条目和被测插件并排挂在同一棵树上,
 * 而且**只记录,不断言** —— 断言留给 `tests/live-host.spec.mjs`。某一步抛了
 * 就把宿主自己的原始错误记下来,这样契约被破坏时看到的是宿主的措辞,而不是
 * 一条断言 diff。
 *
 * 它碰到的每一样东西都属于正在运行的宿主:宿主 `ctx.agents` 工厂造出的真实
 * Agent 与 Session、真实的 `ctx.tools` 注册表与执行管线(pre/guard/around/
 * post 全程)、真实的 `ctx.systemPrompt` 装配、宿主自己的 agent 事件分发器
 * (`agentEvents`,和 agent-loop 驱动一轮时用的是同一个)、宿主自己的
 * `evaluatePluginCompatibility`。
 *
 * 每次启动只测一种插件模式(`PROGRESSIVE_TOOLS_LIVE_MODE`),因为三种模式的
 * 守卫与工具名在同一棵树上会互相干扰。
 * ============================================================ */
import { createRequire } from 'node:module'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  FIXTURE_ECHO,
  FIXTURE_EXCLUSIVE,
  FIXTURE_FAIL,
  FIXTURE_FAIL_CODE,
  FIXTURE_FAIL_NAME,
  FIXTURE_LATE,
  modeToolNames,
} from './live-host-modes.mjs'

export const name = 'tokens-progressive-tools-live-probe'

const REPORT = process.env.PROGRESSIVE_TOOLS_LIVE_REPORT
const HOST_ROOT = process.env.PROGRESSIVE_TOOLS_LIVE_HOST_ROOT
const PROFILE_DIR = process.env.PROGRESSIVE_TOOLS_LIVE_PROFILE_DIR
const PACKAGE_NAME = process.env.PROGRESSIVE_TOOLS_LIVE_PACKAGE
const MODE = process.env.PROGRESSIVE_TOOLS_LIVE_MODE ?? 'native'
const HOME = process.env.DSH_HOME
/** 等宿主自己的服务起来。 */
const READY_TIMEOUT_MS = 120_000
/** 等被测插件的 Loader 行把工具注册上来 —— 行被停用时这段必然等满。 */
const REGISTER_TIMEOUT_MS = 30_000

const { search: SEARCH_TOOL, dispatch: DISPATCH_TOOL } = modeToolNames(MODE)
const hostRequire = createRequire(join(HOST_ROOT, 'package.json'))
const hostImport = specifier => import(pathToFileURL(hostRequire.resolve(specifier)).href)

/** 插件在会话日志里读的事件名。 */
const SESSION_EVENTS = ['tool/call', 'tool/result']
/** 同一件事在两代宿主上的两种拼法:`run_code` 子调用的落盘名。 */
const NESTED_DISPATCH_EVENTS = ['tool/ptc-dispatch', 'tool/code-dispatch']
const NATIVE_PROTOCOL = 'dsh-progressive-tools/native-v1'
const PROXY_PROTOCOL = 'dsh-progressive-tools/v2'
const LEGACY_PROTOCOL = 'dsh-progressive-tools/v1'

function describe(error, depth = 0) {
  if (typeof error !== 'object' || error === null) return { name: typeof error, message: String(error) }
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    stack: typeof error.stack === 'string' ? error.stack.split('\n').slice(0, 12) : undefined,
    ...(error.cause !== undefined && depth < 3 ? { cause: describe(error.cause, depth + 1) } : {}),
  }
}

async function step(steps, id, run) {
  try {
    steps.push({ id, ok: true, value: await run() })
  } catch (error) {
    steps.push({ id, ok: false, error: describe(error) })
  }
  return steps.at(-1)
}

const wait = ms => new Promise((settle) => { setTimeout(settle, ms) })

/** 等宿主注册表里出现被测工具;超时就把注册表当时的全貌一起报出来。 */
async function awaitTool(ctx, tool) {
  const deadline = Date.now() + REGISTER_TIMEOUT_MS
  while (Date.now() < deadline) {
    const definition = ctx.tools.get(tool)
    if (definition !== undefined) return definition
    await wait(200)
  }
  throw new Error(`被测插件始终没有把 ${tool} 注册进宿主注册表;`
    + `宿主此刻可见的工具是:${ctx.tools.schemas().map(schema => schema.name).join('、') || '(空)'}`
    + '。Loader 行被兼容门禁停用、或配置没被读到时就是这个现象')
}

/** 一份工具定义里,插件和宿主之间真正约定的那几件事。 */
const definitionShape = definition => ({
  name: definition.name,
  describesPurpose: typeof definition.description === 'string' && definition.description.length > 0,
  parameters: Object.keys(definition.parameters?.properties ?? definition.parameters ?? {}),
  hasExecute: typeof definition.execute === 'function',
  // 宿主会把我们声明的 schema 规范化成它自己的内部形状(T0047-A 插件体检
  // 实测),所以只带回报告供排查,不断言它长什么样。
  hasOutputSchema: definition.output?.schema !== undefined && definition.output.schema !== null,
  outputSchema: definition.output?.schema,
  hasRender: typeof definition.output?.render === 'function',
  hasPresentationMeta: typeof definition.output?.presentationMeta === 'function',
  classifiesConcurrency: typeof definition.isConcurrencySafe === 'function',
})

/** 只留用例要断言的字段,免得把宿主内部结构整个搬进报告。 */
const summarize = result => ({
  isError: result.isError,
  value: result.value,
  content: result.content,
  meta: result.meta,
  error: result.isError
    ? { message: result.error?.message, code: result.error?.info?.code, name: result.error?.info?.name }
    : undefined,
})

const baseEnv = () => ({ home: HOME, hostRoot: HOST_ROOT, mode: MODE, searchTool: SEARCH_TOOL })

function finish(report) {
  const text = JSON.stringify(report, null, 2)
  if (REPORT) {
    try {
      writeFileSync(REPORT, text)
    } catch {
      process.stdout.write(`PROGRESSIVE-TOOLS-LIVE ${text}\n`)
    }
  }
  // 这个进程归宿主所有;夹具等它退出之后才去读报告。
  setTimeout(() => process.exit(0), 100)
}

export function apply(ctx) {
  // base-only 的 profile 没有常驻 app 把事件循环撑住,所以这个定时器**不**
  // unref:它既是"宿主服务迟迟不就绪"的兜底,也是进程的活口。
  const timer = setTimeout(
    () => finish({ env: baseEnv(), steps: [], fatal: '宿主服务始终没有就绪' }),
    READY_TIMEOUT_MS,
  )
  ctx.inject(['tools', 'systemPrompt', 'agents'], (readyCtx) => {
    clearTimeout(timer)
    const alive = setInterval(() => {}, 1000)
    run(readyCtx).then(
      (steps) => {
        clearInterval(alive)
        finish({ env: baseEnv(), steps })
      },
      (error) => {
        clearInterval(alive)
        finish({ env: baseEnv(), steps: [], fatal: describe(error) })
      },
    )
  })
}

async function run(ctx) {
  const steps = []
  const tools = await hostImport('@deepseek-ai/dsh-tools')
  const llm = await hostImport('@deepseek-ai/dsh-llm')
  const sessions = await hostImport('@deepseek-ai/dsh-session')
  const agents = await hostImport('@deepseek-ai/dsh-agent')
  const hostRuntime = JSON.parse(readFileSync(hostRequire.resolve('@deepseek-ai/dsh/package.json'), 'utf8')).version
  const signal = new AbortController().signal
  let callSeq = 0

  const execute = (agent, tool, args) => ctx.tools.execute({
    agent, signal, name: tool, arguments: args, callId: `pt-${tool}-${(callSeq += 1)}`,
  })
  const assemble = agent => ctx.systemPrompt.assemble(agents.assembleContextFor(agent, signal))
  const assemblyShape = assembly => ({
    tools: assembly.tools.map(schema => schema.name).sort(),
    sections: assembly.sections.map(section => section.name),
    discoverySection: assembly.sections
      .find(section => section.name === 'tokens-progressive-tools:discovery')?.text,
    catalogSection: assembly.sections
      .find(section => section.name === 'tokens-progressive-tools:catalog')?.text,
  })
  const scoped = agent => agent.ctx.tools.schemas(agent).map(schema => schema.name).sort()

  // ---- 被测插件在宿主里的落点 --------------------------------------------
  // 宿主自己也可能带一份同名包,解析错了用例全绿但测的不是待测代码
  // (T0047-A 登录插件踩过),所以这件事单独报一步。
  const installed = await step(steps, 'plugin.resolved', () => {
    const profileRequire = createRequire(join(PROFILE_DIR, 'package.json'))
    const manifestPath = realpathSync(profileRequire.resolve(`${PACKAGE_NAME}/package.json`))
    return {
      entry: realpathSync(profileRequire.resolve(PACKAGE_NAME)),
      manifestPath,
      version: JSON.parse(readFileSync(manifestPath, 'utf8')).version,
      // 插件必须解析到宿主那一份运行时包(它们用 module-local Symbol,
      // 多一份物理副本就对不上服务)。
      toolsFromPlugin: realpathSync(createRequire(manifestPath).resolve('@deepseek-ai/dsh-tools/package.json')),
      toolsFromHost: realpathSync(hostRequire.resolve('@deepseek-ai/dsh-tools/package.json')),
    }
  })

  // ---- 探针自己的夹具工具 ------------------------------------------------
  // 真实宿主工具之外再放三个确定性目标:一个并发安全、一个独占、一个抛宿主
  // 自己的 HarnessError。它们和宿主自带的工具走同一条注册与执行链路。
  const fixture = (toolName, extra) => tools.defineTool({
    name: toolName,
    description: `Probe fixture ${toolName} for the progressive-tools real-host contract suite`,
    parameters: { text: { type: 'string' } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
      presentationMeta: args => ({ echoed: args.text ?? null }),
    },
    execute: async args => `${toolName}:${args.text ?? ''}`,
    ...extra,
  })
  await step(steps, 'probe.fixtures', () => {
    ctx.tools.register(fixture(FIXTURE_ECHO, { isConcurrencySafe: () => true }))
    ctx.tools.register(fixture(FIXTURE_EXCLUSIVE, { isConcurrencySafe: () => false }))
    ctx.tools.register(fixture(FIXTURE_FAIL, {
      isConcurrencySafe: () => true,
      execute: async () => {
        const failure = new llm.HarnessError('probe fixture always fails', FIXTURE_FAIL_CODE)
        failure.name = FIXTURE_FAIL_NAME
        throw failure
      },
    }))
    return { registered: [FIXTURE_ECHO, FIXTURE_EXCLUSIVE, FIXTURE_FAIL] }
  })

  // ---- 插件注册进宿主的东西 ----------------------------------------------
  await step(steps, 'tools.registered', async () => {
    const discovery = await awaitTool(ctx, SEARCH_TOOL)
    const dispatch = DISPATCH_TOOL === undefined ? undefined : await awaitTool(ctx, DISPATCH_TOOL)
    return {
      discovery: definitionShape(discovery),
      dispatch: dispatch === undefined ? undefined : definitionShape(dispatch),
      // 宿主投影给模型看的那份 schema —— 我们声明的参数有没有活着穿过去。
      schema: ctx.tools.schemas().find(entry => entry.name === SEARCH_TOOL),
      registry: ctx.tools.schemas().map(entry => entry.name).sort(),
    }
  })

  // ---- 一个真实 Agent ----------------------------------------------------
  let primary
  const created = await step(steps, 'agent.created', async () => {
    primary = await ctx.agents.create({ sessionId: sessions.SessionId(`pt-live-${MODE}`) })
    return {
      id: String(primary.agent.id),
      live: ctx.agents.get(primary.agent.id) !== undefined,
      historyApi: typeof primary.agent.session?.snapshotEvents === 'function' ? 'snapshotEvents' : 'events',
      scopedTools: scoped(primary.agent),
    }
  })

  if (created.ok) {
    const agent = primary.agent

    // 宿主真实装配:模型看得见的工具清单与分节,都由插件的
    // `system-prompt/assemble` 中间件改写过。
    await step(steps, 'prompt.baseline', async () => assemblyShape(await assemble(agent)))

    // 守卫:还没被发现/加载的工具直调要被拦,而且措辞是插件自己的。
    // dynamic 模式不装守卫(它改的是可见面,见 dynamic.restricted),所以
    // 这一步只对另外两种模式有意义。
    if (MODE !== 'dynamic') {
      await step(steps, 'guard.beforeDiscovery', async () =>
        summarize(await execute(agent, FIXTURE_ECHO, { text: 'blocked' })))
    }

    // 发现工具真调一次:宿主按 output.schema 收下返回值、按 render 产出模型
    // 可见内容、按 presentationMeta 产出私有 meta。
    await step(steps, 'search.status', async () =>
      summarize(await execute(agent, SEARCH_TOOL, { action: 'status' })))

    if (MODE === 'native') await nativeSteps({ steps, agent, execute, assemble, assemblyShape })
    if (MODE === 'stable-proxy') await proxySteps({ steps, ctx, agent, execute, assemble, assemblyShape, fixture })
    if (MODE === 'dynamic') await dynamicSteps({ steps, ctx, agent, execute, agents, scoped })

    // 会话重放:宿主自己的 Session 写一段历史,再由宿主的 agent 工厂 seed
    // 出第二个 Agent —— 插件必须从中恢复已发现的工具。
    await replaySteps({ steps, ctx, sessions, llm, execute, assemble, assemblyShape, scoped })

    // 生命周期收尾:`agent/disposed` 由宿主在句柄释放时发出。
    await step(steps, 'agent.disposed', async () => {
      await primary.dispose()
      return { stillLive: ctx.agents.get(agent.id) !== undefined }
    })
  }

  // ---- 宿主自己的词表与准入 ----------------------------------------------
  await step(steps, 'host.sessionVocabulary', () => {
    const known = sessions.KNOWN_SESSION_EVENT_TYPES
    return {
      hasVocabulary: known instanceof Set,
      read: SESSION_EVENTS.filter(type => known.has(type)),
      missing: SESSION_EVENTS.filter(type => !known.has(type)),
      nestedDispatch: NESTED_DISPATCH_EVENTS.filter(type => known.has(type)),
    }
  })

  await step(steps, 'host.compatibility', async () => {
    let boot
    try {
      boot = await hostImport('@deepseek-ai/dsh-app-boot')
    } catch (error) {
      return { declared: false, reason: `NOT DECLARED:无法导入宿主的 app-boot(${error.message})` }
    }
    if (typeof boot.evaluatePluginCompatibility !== 'function') {
      return { declared: false, reason: 'NOT DECLARED:这个宿主的 app-boot 没有 evaluatePluginCompatibility' }
    }
    if (!installed.ok) throw new Error('没拿到装进来的清单,无法交给宿主判定')
    const manifest = JSON.parse(readFileSync(installed.value.manifestPath, 'utf8'))
    const verdict = boot.evaluatePluginCompatibility(manifest, {}, hostRuntime)
    // 反向对照:同一份清单加一条谁都满足不了的假 peer,必须被报出来 ——
    // 否则上面那个"放行"可能只是评估器在空转。
    const sentinel = boot.evaluatePluginCompatibility({
      ...manifest,
      peerDependencies: { ...manifest.peerDependencies, '@deepseek-ai/dsh-nonexistent': '>=99.0.0' },
    }, {}, hostRuntime)
    // 未满足项的字段名 0.2.0 叫 `peers`、0.2.1 叫 `requirements`。
    const unmet = sentinel === undefined ? undefined : (sentinel.requirements ?? sentinel.peers)
    return {
      declared: true,
      runtime: hostRuntime,
      allowed: verdict === undefined,
      verdict: verdict === undefined ? undefined : JSON.parse(JSON.stringify(verdict)),
      sentinelBlocked: sentinel !== undefined,
      sentinelUnmet: unmet === undefined ? undefined : Object.keys(unmet),
      unmetField: sentinel === undefined
        ? undefined
        : (sentinel.requirements !== undefined ? 'requirements' : (sentinel.peers !== undefined ? 'peers' : 'none')),
    }
  })

  // ---- 夹具安全 ----------------------------------------------------------
  // 报出所有写得到的路径,用例断言它们都在临时目录里。逐项容错:某个宿主取
  // 不到某条路径不该让整步失败,那样守卫就等于没有。
  await step(steps, 'fixture.paths', () => {
    const paths = {}
    const record = (label, read) => {
      try {
        const value = read()
        if (typeof value === 'string' && value !== '') paths[label] = value
      } catch (error) {
        paths[`${label}:unreadable`] = error.message
      }
    }
    record('home', () => HOME)
    record('realHome', () => realpathSync(HOME))
    record('profileDir', () => realpathSync(PROFILE_DIR))
    record('cwd', () => realpathSync(process.cwd()))
    record('installed', () => (installed.ok ? join(installed.value.manifestPath, '..') : undefined))
    record('baseDir', () => ctx.baseDir)
    record('profilesDir', () => join(HOME, 'profiles'))
    // `profileContext` 是 DSH 0.2 才有的服务,0.1 线上恒为 undefined
    // (T0047-A 会议转写实测),所以它缺席不算失败。
    record('profileContextDir', () => ctx.get('profileContext')?.profile?.dir)
    return paths
  })

  return steps
}

/** native:加载 → 下一次装配里出现 → 直调放行。 */
async function nativeSteps({ steps, agent, execute, assemble, assemblyShape }) {
  await step(steps, 'native.load', async () =>
    summarize(await execute(agent, 'tool_search', { action: 'load', names: [FIXTURE_ECHO] })))
  await step(steps, 'native.afterLoad', async () => assemblyShape(await assemble(agent)))
  await step(steps, 'native.callLoaded', async () =>
    summarize(await execute(agent, FIXTURE_ECHO, { text: 'native' })))
  // 搜索落空不等于没有这个能力:插件要给一条恢复路径,而不是空数组。
  // 查询词刻意不是任何真实工具的词(别用"no such capability"这种,它会命中
  // 宿主描述里的 capability/such)。
  await step(steps, 'native.searchMiss', async () =>
    summarize(await execute(agent, 'tool_search', { query: 'qqqzzzxyw' })))
}

/** stable-proxy:搜索 → 分发真实调用 → 错误路由 → 并发分类 → tools/change。 */
async function proxySteps({ steps, ctx, agent, execute, assemble, assemblyShape, fixture }) {
  await step(steps, 'proxy.search', async () =>
    summarize(await execute(agent, 'pt_find', { query: 'probe fixture echo' })))
  await step(steps, 'proxy.dispatch', async () =>
    summarize(await execute(agent, 'pt_run', { name: FIXTURE_ECHO, arguments: { text: 'proxied' } })))
  // 目标工具自己失败时,HarnessError 的身份要活着穿过代理回到宿主结果里。
  await step(steps, 'proxy.dispatchFailure', async () =>
    summarize(await execute(agent, 'pt_run', { name: FIXTURE_FAIL, arguments: {} })))
  // requireDiscovery:没搜到过的名字不许分发。`read` 是宿主真实工具,在本
  // 模式里被折叠,而且从没被搜索命中过。
  await step(steps, 'proxy.undiscovered', async () =>
    summarize(await execute(agent, 'pt_run', { name: 'read', arguments: { path: 'x' } })))
  // 并发分类委托给目标工具自己的分类器。断言的方式是"分发同一个目标时,
  // 宿主给出的调度口径要和它直接给那个目标的一样" —— 不写死宿主用的是
  // 字符串还是 `{ kind }`、也不写死它叫 parallel 还是别的。
  await step(steps, 'proxy.executionMode', () => {
    const kindOf = call => {
      const value = ctx.tools.executionMode(call)
      return typeof value === 'string' ? value : value?.kind
    }
    const direct = toolName => kindOf({ name: toolName, arguments: {} })
    const viaDispatch = toolName => kindOf({ name: 'pt_run', arguments: { name: toolName, arguments: {} } })
    return {
      raw: ctx.tools.executionMode({ name: FIXTURE_ECHO, arguments: {} }),
      safeDirect: direct(FIXTURE_ECHO),
      safeViaDispatch: viaDispatch(FIXTURE_ECHO),
      unsafeDirect: direct(FIXTURE_EXCLUSIVE),
      unsafeViaDispatch: viaDispatch(FIXTURE_EXCLUSIVE),
      unknownViaDispatch: viaDispatch('pt_no_such_tool'),
    }
  })
  // `tools/change`:agent 建好之后才注册的工具也必须进折叠目录,否则它会从
  // 守卫底下漏过去。没有这个事件,下面这一步会放行。
  await step(steps, 'proxy.toolsChange', async () => {
    ctx.tools.register(fixture(FIXTURE_LATE, { isConcurrencySafe: () => true }))
    await wait(100)
    return summarize(await execute(agent, FIXTURE_LATE, { text: 'late' }))
  })
  // deferToolGuidance:被折叠工具的精确指引分节不该留在提示里。
  await step(steps, 'proxy.sections', async () => assemblyShape(await assemble(agent)))
}

/** dynamic:限制可见面 → 搜索激活 → 宿主的轮次事件推进过期。 */
async function dynamicSteps({ steps, ctx, agent, execute, agents, scoped }) {
  await step(steps, 'dynamic.restricted', () => ({ visible: scoped(agent) }))
  await step(steps, 'dynamic.activate', async () => {
    const result = await execute(agent, 'pt_find', { query: 'probe fixture' })
    return { result: summarize(result), visible: scoped(agent) }
  })
  await step(steps, 'dynamic.callActivated', async () =>
    summarize(await execute(agent, FIXTURE_ECHO, { text: 'dynamic' })))
  // 宿主自己的 agent 事件分发器 —— agent-loop 驱动一轮时用的就是它。
  // retentionTurns=1,所以轮次一推进,刚激活的家族必须被收回。
  await step(steps, 'dynamic.inboxClaimed', () => {
    agents.agentEvents(ctx, agent).emit('agent/inbox/claimed', { messages: [], turn: 9, position: undefined })
    return { visible: scoped(agent) }
  })
  await step(steps, 'dynamic.reactivate', async () => {
    await execute(agent, 'pt_find', { query: 'probe fixture' })
    return { visible: scoped(agent) }
  })
  await step(steps, 'dynamic.preStep', async () => {
    const decision = await agents.agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 20, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter', messages: [] }),
    )
    return { decision: decision?.kind, visible: scoped(agent) }
  })
}

/**
 * 会话重放:宿主自己的 Session 写一段历史,再由宿主的 agent 工厂 seed 出
 * 第二个 Agent。三种模式恢复的东西不同,所以可观测的后果也不同:
 * native 恢复"已加载"(装配里出现),dynamic 恢复"已激活家族"(作用域里
 * 出现),stable-proxy 恢复"已发现"(可以直接分发,不必重搜)。
 */
async function replaySteps({ steps, ctx, sessions, llm, execute, assemble, assemblyShape, scoped }) {
  const nested = NESTED_DISPATCH_EVENTS.find(type => sessions.KNOWN_SESSION_EVENT_TYPES.has(type))
  const payload = MODE === 'native'
    ? { protocol: NATIVE_PROTOCOL, allLoadedTools: [FIXTURE_ECHO] }
    : MODE === 'stable-proxy'
      ? { protocol: PROXY_PROTOCOL, action: 'search', allDiscoveredTools: [FIXTURE_ECHO] }
      : {
          protocol: LEGACY_PROTOCOL,
          state: { activeGroups: [{ id: 'probe-fixtures', activatedAtTurn: 1, lastUsedTurn: 1 }] },
        }
  const blocks = [{ type: 'text', text: JSON.stringify(payload) }]

  // 事件是不是"表面事件"(要带 surfaceOp 标记)由宿主自己说了算,不同代
  // 宿主的清单不同;先不带标记试,宿主要求了再补上。
  const append = (session, type, data) => {
    try {
      return session.append(type, data)
    } catch (error) {
      if (!/surfaceOp/.test(String(error?.message))) throw error
      return session.append(type, data, { surfaceOp: 'append' })
    }
  }

  /** 一段宿主自己写出来的历史。`kinds` 决定里面放哪几种事件。 */
  const history = (label, kinds) => {
    const scratch = sessions.Session.create(sessions.SessionId(`pt-replay-src-${MODE}-${label}`))
    let envelope
    if (kinds.includes('result')) {
      const callId = `pt-replay-${label}-1`
      append(scratch, 'tool/call', { turn: 1, step: 1, callId, name: SEARCH_TOOL, arguments: {} })
      // 信封用宿主自己的构造器,不手搓:0.1 把结果块包在一个 `tool-result`
      // 块里、0.2 摊平到 tool 角色的消息上,插件两种都要读得懂。
      const message = llm.createToolResultMessage({
        callId: llm.ToolCallId(callId), isError: false, content: blocks,
      })
      append(scratch, 'tool/result', { turn: 1, step: 1, message })
      envelope = {
        role: message.role,
        topLevelIsError: message.isError,
        firstBlockType: Array.isArray(message.content) ? message.content[0]?.type : undefined,
      }
    }
    if (kinds.includes('nested') && nested !== undefined) {
      append(scratch, nested, {
        rootCallId: `pt-replay-${label}-root`,
        parentCallId: `pt-replay-${label}-root`,
        subCallId: `pt-replay-${label}-root:sub:1`,
        name: SEARCH_TOOL,
        arguments: {},
        isError: false,
        content: blocks,
      })
    }
    const events = scratch.snapshotEvents()
    return {
      nested,
      envelope,
      types: events.map(event => event.type),
      events: JSON.parse(JSON.stringify(events)),
    }
  }

  /** 把一段历史 seed 给宿主的 agent 工厂,看插件恢复出了什么。 */
  const resume = async (label, events) => {
    const handle = await ctx.agents.create({
      sessionId: sessions.SessionId(`pt-replay-${MODE}-${label}`),
      seed: events,
    })
    try {
      const assembly = assemblyShape(await assemble(handle.agent))
      // stable-proxy 恢复的是"已发现":可见面不变,只放开分发闸门,所以
      // 要真分发一次才看得出恢复成功没有。
      const dispatched = MODE === 'stable-proxy'
        ? summarize(await execute(handle.agent, DISPATCH_TOOL, {
          name: FIXTURE_ECHO, arguments: { text: `resumed-${label}` },
        }))
        : undefined
      return { ...assembly, scoped: scoped(handle.agent), dispatched }
    } finally {
      await handle.dispose()
    }
  }

  // ① 完整历史:`tool/call` + `tool/result` + 子调用。
  const full = await step(steps, 'replay.seed', () => history('full', ['result', 'nested']))
  if (full.ok) await step(steps, 'replay.resumed', () => resume('full', full.value.events))

  // ② 只有 `tool/result`:逼着插件去读宿主自己写的那个信封。0.1 包裹、
  //    0.2 摊平,少认一种就在那条产品线上静默恢复不出东西。
  const resultOnly = await step(steps, 'replay.resultOnlySeed', () => history('result', ['result']))
  if (resultOnly.ok) {
    await step(steps, 'replay.resultOnly', () => resume('result', resultOnly.value.events))
  }

  // ③ 只有 `run_code` 子调用:逼着插件去读宿主自己用的那个子调用事件名。
  //    0.1.3 叫 code-dispatch、0.1.5 起叫 ptc-dispatch,少认一个同样静默。
  const nestedOnly = await step(steps, 'replay.nestedOnlySeed', () => history('nested', ['nested']))
  if (nestedOnly.ok) {
    await step(steps, 'replay.nestedOnly', () => resume('nested', nestedOnly.value.events))
  }
}
