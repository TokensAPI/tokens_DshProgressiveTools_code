/* ============================================================
 * PT-HOST-01…30:真实宿主契约
 * ============================================================
 * 本仓库别的用例都自己供宿主。这一组相反:宿主侧**一个桩都不打** ——
 * staged 宿主自带的 launcher 起一个一次性 profile,真实加载器按本包发布的
 * `cordis.patch.yml` 和 `files` 白名单把插件装进去,宿主的 agent 工厂造出
 * 真实 Agent,然后把**插件用到的每一个宿主接口各真调一次**。
 *
 * 口径(agent-hub T0047 A″):
 * - 只断言插件真正依赖的东西(它调的接口、它读的字段、它订阅的事件名),
 *   宿主新增字段/事件/工具一律算兼容;不断言词表大小、工具全清单、宿主
 *   内部字段顺序。
 * - 形状校验交给宿主自己的 schema / 构造器 / 调度分类器,不手写期望对象。
 * - 每条用例写清"插件依赖的是什么",升级后红了能一眼看出该改哪边。
 *
 * 没有 `DSH_HOST_ROOT` 时每条显式报 NOT EXECUTED(跳过,不伪造通过),
 * `npm run check:host` 在那种情况下退出码非 0。
 * ============================================================ */
import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  MODES,
  REAL_DSH_HOME,
  SKIP_WITHOUT_HOST,
  forEachHost,
  hostRoots,
  inside,
  liveHostReports,
  liveValue,
  realHomeSnapshot,
  reportsForMode,
} from './support/live-host.mjs'
import { hostBusEvents } from './support/host-vocabulary.mjs'
import {
  FIXTURE_ECHO,
  FIXTURE_EXCLUSIVE,
  FIXTURE_FAIL,
  FIXTURE_FAIL_CODE,
  FIXTURE_FAIL_NAME,
  FIXTURE_LATE,
  modeToolNames,
} from './support/live-host-modes.mjs'
import { DEFAULT_ALWAYS_VISIBLE } from '../src/defaults.js'
import { matchesToolName } from '../src/catalog.js'

/** 插件订阅的 Cordis 总线事件 —— 名字错了加载不报错、门禁也拦不到。 */
const BUS_EVENTS = [
  'system-prompt/assemble',
  'agent/created',
  'agent/disposed',
  'agent/inbox/claimed',
  'agent/pre-step',
  'tools/result',
  'tools/change',
]

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

let reports = []

beforeAll(async () => {
  if (SKIP_WITHOUT_HOST) return
  reports = await liveHostReports()
}, 1_800_000)

/**
 * 注册一条用例。没有宿主时它显式跳过并在名字里写明 NOT EXECUTED,
 * 这样 `npm test` 的输出里能一眼看到哪些没真跑。
 * @param {string} id - 用例编号。
 * @param {string} about - 插件依赖的是什么。
 * @param {() => void} check - 断言体。
 */
function hostCase(id, about, check, timeout) {
  if (SKIP_WITHOUT_HOST) {
    it.skip(`${id} ${about} — ${SKIP_WITHOUT_HOST}`, () => {})
    return
  }
  it(`${id} ${about}`, check, timeout)
}

/** 某个模式下的那几份报告(每个宿主一份)。 */
const forMode = mode => reportsForMode(reports, mode)
/** 所有报告。 */
const all = () => reports

/**
 * "恢复成功"在三种模式下的样子不同:native 恢复的是"已加载"(模型看得见),
 * dynamic 恢复的是"已激活家族"(作用域里出现),stable-proxy 恢复的是
 * "已发现"(可见面不变,但分发闸门打开,所以要真分发一次才看得出来)。
 * @param {object} report - 一份宿主报告。
 * @param {object} resumed - 一次重放的观测结果。
 */
function expectRestored(report, resumed) {
  if (report.mode === 'native') expect(resumed.tools).toContain(FIXTURE_ECHO)
  else if (report.mode === 'dynamic') {
    expect(resumed.scoped).toContain(FIXTURE_ECHO)
    // 只恢复了那一个家族,不是"恢复后干脆什么都看得见" —— 没有这一条,
    // 一个根本不收窄可见面的实现也能让上一行恒真。
    const registry = liveValue(report, 'tools.registered').registry
    const outside = registry.filter(toolName => !toolName.startsWith('pt_'))
    expect(outside.length, '宿主注册表里没有本插件之外的工具,这条对照会变成空转').toBeGreaterThan(0)
    expect(outside.filter(toolName => resumed.scoped.includes(toolName))).toEqual([])
  } else {
    expect(resumed.tools).not.toContain(FIXTURE_ECHO)
    expect(resumed.dispatched?.isError, JSON.stringify(resumed.dispatched?.error)).toBe(false)
    expect(resumed.dispatched?.value.tool).toBe(FIXTURE_ECHO)
  }
}

describe('PT-HOST 真实宿主契约', () => {
  // ---- 装载与注册 --------------------------------------------------------

  hostCase('PT-HOST-01', '真实加载器按本包发布的文件集把插件挂起来,且它解析到的运行时包就是宿主那一份', () => {
    forEachHost(all(), (report) => {
      const resolved = liveValue(report, 'plugin.resolved')
      // 装进去的是 profile 里那份副本,不是宿主自带的同名包(登录插件踩过:
      // 解析错了用例全绿,但测的不是待测代码)。
      expect(inside(resolved.entry, report.realHome), `entry ${resolved.entry} 不在一次性 $DSH_HOME 内`).toBe(true)
      expect(resolved.version).toBe(manifest.version)
      // 运行时包用 module-local Symbol:插件必须解析到宿主那一份物理副本。
      expect(resolved.toolsFromPlugin).toBe(resolved.toolsFromHost)
    })
  })

  hostCase('PT-HOST-02', 'inject 被尊重,ctx.tools.register 收下发现工具,声明的参数穿过宿主的 schema 投影', () => {
    forEachHost(all(), (report) => {
      const registered = liveValue(report, 'tools.registered')
      const { search } = modeToolNames(report.mode)
      expect(registered.discovery.name).toBe(search)
      expect(registered.discovery.hasExecute).toBe(true)
      expect(registered.discovery.describesPurpose).toBe(true)
      // 宿主会把 output.schema 规范化成它自己的内部形状,所以只断言"宿主
      // 收下了",不断言它长什么样。
      expect(registered.discovery.hasOutputSchema).toBe(true)
      expect(registered.discovery.hasRender).toBe(true)
      expect(registered.discovery.hasPresentationMeta).toBe(true)
      // 并发分类器只有 native 和 stable-proxy 的发现工具声明(前者要串行化
      // 累计快照,后者声明自己可并行);dynamic 不声明,就不在这里要求。
      if (report.mode !== 'dynamic') expect(registered.discovery.classifiesConcurrency).toBe(true)
      // 插件声明的参数必须活着到达模型可见的那份 schema。
      const projected = Object.keys(registered.schema?.parameters?.properties ?? {})
      expect(projected).toEqual(expect.arrayContaining(['action', 'query', 'max_results']))
      expect(registered.registry).toContain(search)
    })
  })

  hostCase('PT-HOST-03', 'stable-proxy 的固定分发器也进了宿主注册表,带必填的 name/arguments', () => {
    forEachHost(forMode('stable-proxy'), (report) => {
      const registered = liveValue(report, 'tools.registered')
      const { dispatch } = modeToolNames(report.mode)
      expect(registered.dispatch?.name).toBe(dispatch)
      expect(registered.dispatch?.hasExecute).toBe(true)
      expect(registered.dispatch?.classifiesConcurrency).toBe(true)
      expect(registered.dispatch?.parameters).toEqual(expect.arrayContaining(['name', 'arguments']))
    })
  })

  hostCase('PT-HOST-04', '宿主的 agent 工厂造出的真实 Agent 带 session,插件在它公布时已就位', () => {
    forEachHost(all(), (report) => {
      const created = liveValue(report, 'agent.created')
      expect(created.live).toBe(true)
      // 插件两种历史读法都支持;这里只记录宿主实际给的是哪一种。
      expect(['snapshotEvents', 'events']).toContain(created.historyApi)
      expect(created.scopedTools.length).toBeGreaterThan(0)
    })
  })

  // ---- 提示装配 ----------------------------------------------------------

  hostCase('PT-HOST-05', 'system-prompt/assemble 中间件真的收窄了模型可见的工具清单', () => {
    forEachHost(all(), (report) => {
      const registry = liveValue(report, 'tools.registered').registry
      const baseline = liveValue(report, 'prompt.baseline')
      const { search } = modeToolNames(report.mode)
      // 可见面是注册表的子集,而且确实少了东西。
      expect(registry).toEqual(expect.arrayContaining(baseline.tools))
      expect(baseline.tools.length).toBeLessThan(registry.length)
      // 发现工具自己永远可见,否则模型没有入口。
      expect(baseline.tools).toContain(search)
      // 还没被发现的工具不能出现在模型眼前。
      expect(baseline.tools).not.toContain(FIXTURE_ECHO)
    })
  })

  hostCase('PT-HOST-06', 'ctx.systemPrompt.section 的固定文本与函数文本都进了宿主的装配结果', () => {
    forEachHost(forMode('native'), (report) => {
      const baseline = liveValue(report, 'prompt.baseline')
      const { search } = modeToolNames(report.mode)
      expect(baseline.sections).toContain('tokens-progressive-tools:discovery')
      expect(baseline.discoverySection).toContain(search)
      // catalog 节的文本是个函数,宿主要把 agent 传给它;目录内容来自真实
      // 注册表,所以它必须提到探针注册的那个家族。
      expect(baseline.sections).toContain('tokens-progressive-tools:catalog')
      expect(baseline.catalogSection).toMatch(/\btools\)/)
      expect(baseline.catalogSection).toContain('pt:')
    })
    forEachHost(forMode('stable-proxy'), (report) => {
      const baseline = liveValue(report, 'prompt.baseline')
      expect(baseline.sections).toContain('tokens-progressive-tools:discovery')
      expect(baseline.discoverySection).toContain(modeToolNames(report.mode).dispatch)
    })
  })

  hostCase('PT-HOST-07', '配置经宿主加载器到达插件:非默认的 toolName 与 alwaysVisible 生效,默认值没有生效', () => {
    for (const mode of ['stable-proxy', 'dynamic']) {
      forEachHost(forMode(mode), (report) => {
        const registry = liveValue(report, 'tools.registered').registry
        const visible = mode === 'dynamic'
          ? liveValue(report, 'dynamic.restricted').visible
          : liveValue(report, 'prompt.baseline').tools
        // 非默认工具名 —— 插件不读配置就会叫 tool_search。
        expect(registry).toContain(modeToolNames(mode).search)
        expect(registry).not.toContain('tool_search')
        // 覆盖进去的 alwaysVisible 生效。
        expect(visible).toContain(FIXTURE_EXCLUSIVE)
        // 而默认 alwaysVisible 会放行的真实宿主工具被折叠了 —— 配置值等于
        // 默认值的用例是空转,这一条专门挡那种。
        const defaultsWouldKeep = registry.filter(toolName =>
          matchesToolName(toolName, [...DEFAULT_ALWAYS_VISIBLE]))
        expect(defaultsWouldKeep.length,
          '宿主注册表里没有任何默认 alwaysVisible 命中的工具,这条对照会变成空转').toBeGreaterThan(0)
        expect(defaultsWouldKeep.filter(toolName => visible.includes(toolName))).toEqual([])
      })
    }
  })

  // ---- 执行管线 ----------------------------------------------------------

  hostCase('PT-HOST-08', 'ctx.tools.guard 真的拦住未发现的工具,理由是插件自己的措辞', () => {
    for (const mode of ['native', 'stable-proxy']) {
      forEachHost(forMode(mode), (report) => {
        const blocked = liveValue(report, 'guard.beforeDiscovery')
        expect(blocked.isError).toBe(true)
        expect(blocked.error.message).toContain(FIXTURE_ECHO)
        // 是守卫拦的,不是宿主的参数校验或"没这个工具"。
        expect(blocked.error.message).toContain(modeToolNames(mode).search)
      })
    }
  })

  hostCase('PT-HOST-09', '发现工具真执行一次:宿主收下返回值、按 render 产出内容、按 presentationMeta 产出私有 meta', () => {
    forEachHost(all(), (report) => {
      const status = liveValue(report, 'search.status')
      expect(status.isError).toBe(false)
      expect(status.value?.protocol).toMatch(/^dsh-progressive-tools\//)
      // render 的产物是模型看到的内容。
      expect(Array.isArray(status.content)).toBe(true)
      expect(status.content[0]?.type).toBe('text')
      // presentationMeta 的产物是宿主留给插件自己的 meta,不进模型上下文。
      expect(status.meta?.protocol).toBe(status.value.protocol)
      if (report.mode === 'native') {
        // 累计清单只进 meta;渲染出去会让发现表越滚越大回灌进提示。
        expect(status.meta.allLoadedTools).toBeDefined()
        expect(status.content[0].text).not.toContain('allLoadedTools')
      }
    })
  })

  hostCase('PT-HOST-10', 'native:load 之后工具进入下一次装配,守卫放行,真工具真跑出结果', () => {
    forEachHost(forMode('native'), (report) => {
      const loaded = liveValue(report, 'native.load')
      expect(loaded.isError).toBe(false)
      expect(loaded.value.loadedTools).toContain(FIXTURE_ECHO)
      expect(liveValue(report, 'native.afterLoad').tools).toContain(FIXTURE_ECHO)
      const called = liveValue(report, 'native.callLoaded')
      expect(called.isError).toBe(false)
      expect(called.value).toContain('native')
      expect(called.meta).toEqual({ echoed: 'native' })
    })
  })

  hostCase('PT-HOST-11', 'native:零命中要给一条恢复路径,而不是让模型以为没有这个能力', () => {
    forEachHost(forMode('native'), (report) => {
      const miss = liveValue(report, 'native.searchMiss')
      expect(miss.isError).toBe(false)
      expect(miss.value.tools).toEqual([])
      expect(miss.value.instruction).toMatch(/status|exact names|keywords/i)
    })
  })

  hostCase('PT-HOST-12', 'stable-proxy:一次搜索在真实目录上命中并记下发现', () => {
    forEachHost(forMode('stable-proxy'), (report) => {
      const found = liveValue(report, 'proxy.search')
      expect(found.isError).toBe(false)
      expect(found.value.protocol).toBe('dsh-progressive-tools/v2')
      expect(found.value.allDiscoveredTools).toContain(FIXTURE_ECHO)
      expect(found.meta.discoveredTools).toContain(FIXTURE_ECHO)
    })
  })

  hostCase('PT-HOST-13', 'stable-proxy:嵌套 ctx.tools.execute 真调目标工具,目标的内容块原样回传', () => {
    forEachHost(forMode('stable-proxy'), (report) => {
      const dispatched = liveValue(report, 'proxy.dispatch')
      expect(dispatched.isError).toBe(false)
      expect(dispatched.value.tool).toBe(FIXTURE_ECHO)
      // 目标工具自己的产物穿过代理没有被改写。
      expect(dispatched.content[0]?.text).toContain('proxied')
      expect(dispatched.meta).toMatchObject({ tool: FIXTURE_ECHO })
    })
  })

  hostCase('PT-HOST-14', 'stable-proxy:目标失败时 HarnessError 的错误码与名字穿过代理回到宿主结果', () => {
    forEachHost(forMode('stable-proxy'), (report) => {
      const failed = liveValue(report, 'proxy.dispatchFailure')
      expect(failed.isError).toBe(true)
      expect(failed.error.message).toContain(FIXTURE_FAIL)
      // 可路由的失败身份不能被压成一条无结构的消息。
      expect(failed.error.code).toBe(FIXTURE_FAIL_CODE)
      expect(failed.error.name).toBe(FIXTURE_FAIL_NAME)
    })
  })

  hostCase('PT-HOST-15', 'stable-proxy:requireDiscovery 拦住没被搜索过的真实工具', () => {
    forEachHost(forMode('stable-proxy'), (report) => {
      const rejected = liveValue(report, 'proxy.undiscovered')
      expect(rejected.isError).toBe(true)
      expect(rejected.error.message).toMatch(/has not been discovered/)
    })
  })

  hostCase('PT-HOST-16', 'stable-proxy:并发分类委托给目标自己的分类器,宿主给分发的口径与直调一致', () => {
    forEachHost(forMode('stable-proxy'), (report) => {
      const modes = liveValue(report, 'proxy.executionMode')
      // 不写死宿主叫它 parallel 还是别的,只要求"经代理 == 直调目标"。
      expect(modes.safeViaDispatch).toBe(modes.safeDirect)
      expect(modes.unsafeViaDispatch).toBe(modes.unsafeDirect)
      // 两类目标的口径必须不同,否则上面两条是恒真的。
      expect(modes.safeDirect).not.toBe(modes.unsafeDirect)
      // 认不出的目标按最保守的那一类排。
      expect(modes.unknownViaDispatch).toBe(modes.unsafeDirect)
    })
  })

  hostCase('PT-HOST-17', 'stable-proxy:tools/change 让 agent 建好之后注册的工具也进折叠目录', () => {
    forEachHost(forMode('stable-proxy'), (report) => {
      const late = liveValue(report, 'proxy.toolsChange')
      // 没有这个事件,后注册的工具会从守卫底下漏过去直接可调。
      expect(late.isError).toBe(true)
      expect(late.error.message).toContain(FIXTURE_LATE)
    })
  })

  hostCase('PT-HOST-18', 'stable-proxy:被折叠工具的精确指引分节从提示里摘掉,没折叠的那些保留', () => {
    const exact = (sections, toolName) =>
      sections.some(section => section === `tool:${toolName}` || section.startsWith(`tool:${toolName}:`))
    for (const report of forMode('stable-proxy')) {
      const sections = liveValue(report, 'proxy.sections').sections
      const registry = liveValue(report, 'tools.registered').registry
      const visible = liveValue(report, 'proxy.sections').tools
      const deferred = registry.filter(toolName => !visible.includes(toolName))
      expect(deferred.filter(toolName => exact(sections, toolName)),
        `宿主 ${report.version}:被折叠工具的精确指引分节还留在提示里`).toEqual([])
      // 反向对照:同一个宿主在不折叠的模式下确实有这些分节,否则上面那条
      // 只是"这个宿主压根不发 tool:<名字> 分节"。
      const sameHost = all().find(other => other.root === report.root && other.mode === 'dynamic')
      const unfiltered = liveValue(sameHost, 'replay.resumed').sections
      const strippedSomething = deferred.filter(toolName => exact(unfiltered, toolName))
      expect(strippedSomething.length,
        `宿主 ${report.version}:dynamic 模式也没有任何 tool:<名字> 分节,这条对照是空转`).toBeGreaterThan(0)
    }
  })

  // ---- dynamic:真实的可见面收窄 -----------------------------------------

  hostCase('PT-HOST-19', 'dynamic:ctx.tools.restrict 真的改变了 agent 作用域里的工具', () => {
    forEachHost(forMode('dynamic'), (report) => {
      const registry = liveValue(report, 'tools.registered').registry
      const visible = liveValue(report, 'dynamic.restricted').visible
      expect(visible.length).toBeLessThan(registry.length)
      expect(visible).toContain(modeToolNames('dynamic').search)
      expect(visible).not.toContain(FIXTURE_ECHO)
    })
  })

  hostCase('PT-HOST-20', 'dynamic:一次搜索激活家族,被激活的工具在真实作用域里出现并可直调', () => {
    forEachHost(forMode('dynamic'), (report) => {
      const activated = liveValue(report, 'dynamic.activate')
      expect(activated.result.isError).toBe(false)
      expect(activated.result.value.activatedGroups).toContain('probe-fixtures')
      // 断言的是**变化**:激活前看不见、激活后看得见。只断言"激活后看得见"
      // 的话,一个根本不收窄可见面的实现也能让它恒真。
      const before = liveValue(report, 'dynamic.restricted').visible
      expect(before).not.toContain(FIXTURE_ECHO)
      expect(activated.visible).toEqual(expect.arrayContaining([FIXTURE_ECHO, FIXTURE_FAIL]))
      const called = liveValue(report, 'dynamic.callActivated')
      expect(called.isError).toBe(false)
      expect(called.value).toContain('dynamic')
    })
  })

  hostCase('PT-HOST-21', 'dynamic:宿主的 agent/inbox/claimed 到达插件并推进轮次,过期的家族被收回', () => {
    forEachHost(forMode('dynamic'), (report) => {
      // 事件没到达的话轮次不会推进,家族也就不会过期。
      expect(liveValue(report, 'dynamic.inboxClaimed').visible).not.toContain(FIXTURE_ECHO)
      // 再激活一次,证明收回不是因为它本来就没激活过。
      expect(liveValue(report, 'dynamic.reactivate').visible).toContain(FIXTURE_ECHO)
    })
  })

  hostCase('PT-HOST-22', 'dynamic:宿主以 waterfall 调用 agent/pre-step 中间件,插件放行并推进轮次', () => {
    forEachHost(forMode('dynamic'), (report) => {
      const prestep = liveValue(report, 'dynamic.preStep')
      // 中间件必须把决定原样交还,否则插件会吞掉一轮。
      expect(prestep.decision).toBe('enter')
      expect(prestep.visible).not.toContain(FIXTURE_ECHO)
    })
  })

  // ---- 会话重放 ----------------------------------------------------------

  hostCase('PT-HOST-23', '宿主自己的 Session 接受插件读的那几个事件名,结果信封由宿主构造器产出', () => {
    forEachHost(all(), (report) => {
      const seed = liveValue(report, 'replay.seed')
      expect(seed.types).toEqual(expect.arrayContaining(['tool/call', 'tool/result']))
      // `run_code` 子调用在 0.1 叫 code-dispatch、0.2 叫 ptc-dispatch,
      // 插件两个都读;这里只要求宿主自己认的那个被写进去了。
      expect(seed.nested).toBeDefined()
      expect(seed.types).toContain(seed.nested)
      // 两代信封二选一,不能是半认识的混合体。
      const wrapped = seed.envelope.firstBlockType === 'tool-result'
      expect(seed.envelope.role).toBe(wrapped ? 'user' : 'tool')
    })
  })

  hostCase('PT-HOST-24', '宿主 seed 出来的第二个 Agent 上,插件从真实会话日志恢复了发现状态', () => {
    forEachHost(all(), report => expectRestored(report, liveValue(report, 'replay.resumed')))
  })

  hostCase('PT-HOST-31', '只有 tool/result 的历史也能恢复:插件读得懂宿主自己构造的那种结果信封', () => {
    forEachHost(all(), (report) => {
      // 0.1 把结果块包在一个 `tool-result` 块里、0.2 摊平到 tool 角色消息上。
      // 少认一种就会在那条产品线上静默恢复不出任何东西。
      expectRestored(report, liveValue(report, 'replay.resultOnly'))
    })
  })

  hostCase('PT-HOST-32', '只有 run_code 子调用的历史也能恢复:插件读得懂宿主自己用的那个子调用事件名', () => {
    forEachHost(all(), (report) => {
      expect(liveValue(report, 'replay.nestedOnlySeed').nested).toBeDefined()
      expectRestored(report, liveValue(report, 'replay.nestedOnly'))
    })
  })

  hostCase('PT-HOST-25', '句柄释放后宿主把 agent 从注册表摘掉(插件的每 agent 清理挂在这条边上)', () => {
    forEachHost(all(), (report) => {
      expect(liveValue(report, 'agent.disposed').stillLive).toBe(false)
    })
  })

  // ---- 宿主词表与准入 ----------------------------------------------------

  hostCase('PT-HOST-26', '插件读的会话事件名在宿主自己的词表里,子调用名至少认得一个', () => {
    forEachHost(all(), (report) => {
      const vocabulary = liveValue(report, 'host.sessionVocabulary')
      expect(vocabulary.hasVocabulary).toBe(true)
      expect(vocabulary.missing).toEqual([])
      expect(vocabulary.nestedDispatch.length).toBeGreaterThan(0)
    })
  })

  hostCase('PT-HOST-27', '插件订阅的 Cordis 总线事件名都在宿主声明的监听器签名里', () => {
    for (const root of hostRoots()) {
      const declared = hostBusEvents(root)
      expect(declared.size, `${root}:没扫到任何事件声明,这条用例会变成空转`).toBeGreaterThan(0)
      expect(BUS_EVENTS.filter(event => !declared.has(event)), `${root}`).toEqual([])
    }
    // 扫的是宿主每个包的 lib/types 下所有 .d.ts,一个宿主约 1 秒。
  }, 120_000)

  hostCase('PT-HOST-28', '宿主自己的准入评估放行本包真实清单,而谁都满足不了的假 peer 会被它报出来', () => {
    forEachHost(all(), (report) => {
      const verdict = liveValue(report, 'host.compatibility')
      if (!verdict.declared) {
        // 0.1 线的 app-boot 没有这个函数 —— 如实报告,不算通过也不算失败。
        console.warn(`PT-HOST-28 NOT DECLARED @ ${report.version}/${report.mode}: ${verdict.reason}`)
        return
      }
      expect(verdict.allowed, `宿主拒绝了本包:${JSON.stringify(verdict.verdict)}`).toBe(true)
      // 反向对照:没有它,"放行"可能只是评估器在空转。
      expect(verdict.sentinelBlocked).toBe(true)
      expect(verdict.sentinelUnmet).toContain('@deepseek-ai/dsh-nonexistent')
      // 未满足项的字段名 0.2.0 叫 peers、0.2.1 叫 requirements,两个都要认。
      expect(['peers', 'requirements']).toContain(verdict.unmetField)
    })
  })

  // ---- 夹具安全 ----------------------------------------------------------

  hostCase('PT-HOST-29', '夹具安全:宿主落地的每个路径都在一次性临时目录内,没有一个在用户真实 ~/.dsh 下', () => {
    forEachHost(all(), (report) => {
      const paths = liveValue(report, 'fixture.paths')
      const checked = Object.entries(paths).filter(([label]) => !label.endsWith(':unreadable'))
      expect(checked.length, '探针一条路径都没报出来,这条围栏会变成装饰品').toBeGreaterThan(2)
      for (const [label, value] of checked) {
        expect(inside(value, report.realHome), `${label} = ${value} 不在一次性 $DSH_HOME 内`).toBe(true)
        expect(inside(value, REAL_DSH_HOME), `${label} = ${value} 落在用户真实的 ~/.dsh 下`).toBe(false)
      }
    })
  })

  hostCase('PT-HOST-30', '夹具安全:用户真实 ~/.dsh 顶层条目的大小与 mtime 在启动前后完全相同', () => {
    forEachHost(all(), (report) => {
      // 断言路径只能证明"我们以为写在临时目录";这一条才证明用户的目录
      // 确实没被动过(联网搜索那次把真实 settings.yaml 改成了测试值)。
      expect(report.realHomeAfter).toEqual(report.realHomeBefore)
    })
  })
})

describe('PT-GUARD 夹具守卫自检(不需要宿主)', () => {
  it('PT-GUARD-01 inside() 不是恒真:兄弟目录与前缀同名目录都不算在内', () => {
    const base = join('C:', 'tmp', 'live-abc')
    expect(inside(join(base, 'profiles'), base)).toBe(true)
    expect(inside(base, base)).toBe(true)
    expect(inside(join('C:', 'tmp', 'live-abcd'), base)).toBe(false)
    expect(inside(join('C:', 'tmp', 'other'), base)).toBe(false)
    expect(inside(REAL_DSH_HOME, base)).toBe(false)
  })

  it('PT-GUARD-02 realHomeSnapshot() 是一张真快照,不是恒等于自身的空对象', () => {
    const snapshot = realHomeSnapshot()
    expect(typeof snapshot).toBe('object')
    // 同一时刻两次快照必须相等(PT-HOST-30 的比较才有意义)……
    expect(realHomeSnapshot()).toEqual(snapshot)
    // ……而一个被改过的条目必须让它们不相等。
    expect({ ...snapshot, 'settings.yaml': { size: 1, mtimeMs: 1 } }).not.toEqual(snapshot)
  })

  it('PT-GUARD-03 没有宿主时整组用例报 NOT EXECUTED,不伪造通过', () => {
    if (hostRoots().length > 0) {
      expect(SKIP_WITHOUT_HOST).toBe(false)
      expect(MODES.length).toBe(3)
      return
    }
    expect(SKIP_WITHOUT_HOST).toContain('NOT EXECUTED')
  })
})
