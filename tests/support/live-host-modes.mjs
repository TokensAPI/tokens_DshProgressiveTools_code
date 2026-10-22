/**
 * 三种模式各自装进真实宿主时用的那份配置。
 *
 * 夹具(铺 profile)和探针(在宿主里跑)都要知道同一组名字,所以放在这里
 * 一处,两边都 import。
 *
 * `native` 故意**不给配置**:走的就是本包 `cordis.patch.yml` 发布出去的那份
 * 默认形态,于是"published 的 patch + files 在真实宿主里装得起来"也被钉住。
 * 另外两种模式的配置都刻意**不等于默认值** —— `toolName`、`dispatchToolName`
 * 和 `alwaysVisible` 都改过。配置值等于默认值的用例是空转:插件完全不读配置
 * 也照样绿(T0047-A 更新插件实测的那类)。`alwaysVisible` 尤其关键:默认值里
 * 有 `read` / `write` / `edit` / `glob` / `grep` 等一长串,这里换成一个探针
 * 自己注册的夹具名,于是"只有它常驻、宿主的 read 被折叠"只可能来自配置。
 *
 * 常驻名用探针的夹具而不是宿主自带的工具,是因为宿主自带的那套按平台不同
 * (Windows 上是 `pwsh`,Linux 上是 `bash`),写死任何一个都会在另一个平台
 * 变成"配置生效了但看不出来"。
 */

/** 探针注册的夹具工具前缀 —— 真实宿主工具之外,给分发/并发分类用的确定性目标。 */
export const FIXTURE_PREFIX = 'pt_fixture_'
export const FIXTURE_ECHO = `${FIXTURE_PREFIX}echo`
export const FIXTURE_FAIL = `${FIXTURE_PREFIX}fail`
export const FIXTURE_EXCLUSIVE = `${FIXTURE_PREFIX}exclusive`
/** `tools/change` 用:agent 建好之后才注册,所以它只能靠那个事件进目录。 */
export const FIXTURE_LATE = `${FIXTURE_PREFIX}late`
/** 夹具工具失败时带的错误码 —— 宿主要把它原样路由到 `result.error.info`。 */
export const FIXTURE_FAIL_CODE = 'PT_FIXTURE_FAILURE'
export const FIXTURE_FAIL_NAME = 'ProgressiveToolsFixtureError'

/** 覆盖配置用的工具名(都不等于默认的 `tool_search` / `tool_dispatch`)。 */
const SEARCH = 'pt_find'
const DISPATCH = 'pt_run'

/** 夹具工具自成一个家族,这样搜索/激活的目标是确定的。 */
const FIXTURE_GROUP = {
  id: 'probe-fixtures',
  description: 'Probe fixture tools used by the real-host contract suite',
  aliases: ['fixture', 'probe'],
  include: [`${FIXTURE_PREFIX}*`],
}

/** 被测模式,按启动顺序。 */
export const MODES = ['native', 'stable-proxy', 'dynamic']

/**
 * 某个模式下插件实际用的工具名。
 * @param {string} mode - 模式名。
 * @returns {{ search: string, dispatch: string | undefined }}
 */
export function modeToolNames(mode) {
  if (mode === 'native') return { search: 'tool_search', dispatch: undefined }
  if (mode === 'stable-proxy') return { search: SEARCH, dispatch: DISPATCH }
  return { search: SEARCH, dispatch: undefined }
}

/**
 * profile patch 里要覆盖进本包那一行的配置;native 返回 undefined(不覆盖)。
 * @param {string} mode - 模式名。
 * @returns {object | undefined}
 */
export function modeProfileConfig(mode) {
  if (mode === 'native') return undefined
  if (mode === 'stable-proxy') {
    return {
      mode: 'stable-proxy',
      toolName: SEARCH,
      dispatchToolName: DISPATCH,
      alwaysVisible: [FIXTURE_EXCLUSIVE],
      groups: [FIXTURE_GROUP],
      requireDiscovery: true,
      maxResults: 8,
    }
  }
  return {
    mode: 'dynamic',
    toolName: SEARCH,
    alwaysVisible: [FIXTURE_EXCLUSIVE],
    groups: [FIXTURE_GROUP],
    // 1 轮不活跃就过期:这是"宿主的 pre-step / inbox 事件真的到达插件"唯一
    // 可观测的后果 —— 只有它们会推进 currentTurn。
    retentionTurns: 1,
    maxResults: 8,
  }
}
