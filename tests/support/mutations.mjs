/**
 * 变异:把装进真实宿主的那份副本按名字弄坏,要求指定的用例**必须红**。
 *
 * 契约用例最容易出的毛病是空转 —— 断言的那条路径压根没被走到,或者两边都
 * 回落到同一个默认值(agent-hub T0047-A 在模型管理、更新插件上都实测到过)。
 * 所以每条用例都配一次"把被测路径弄坏 → 必须红"的验证,而且做成常驻机制而
 * 不是一次性手工操作:`npm run check:host -- --mutate <名字>`。
 *
 * 变异只改**装进 profile 的那份副本**(发布出去的 `lib/` 产物或清单),
 * 工作区一个字节都不动。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 对一个文件做一次必须命中的字符串替换。 */
function patch(root, file, from, to) {
  const path = join(root, file)
  const before = readFileSync(path, 'utf8')
  const after = before.replace(from, to)
  if (after === before) {
    throw new Error(`变异没有命中 ${file}:找不到 ${from instanceof RegExp ? from.source : from}`)
  }
  writeFileSync(path, after)
}

/** 把一次 `ctx.tools.<方法>(…)` 调用吞掉,保留参数表达式不被求值的副作用之外的一切。 */
const swallowCall = (root, file, call) => patch(root, file, call, '((unused) => undefined)(')

/**
 * 变异清单:名字 → { 说明, 期望恰好变红的用例, 可选说明 }。
 *
 * `cases` 是**精确**集合:`check:host --mutate` 要求红的恰好是这些,多红
 * (用例互相牵连)或少红(用例空转)都算验证失败。集合是按「配置了全部三个
 * staged 宿主」实测记下来的;只配一个宿主跑某些变异会少红,那是预期之中的
 * ——`peer-0.1-only` 就是靠这个差别证明它不是误报。
 */
export const MUTATIONS = {
  'no-guard': {
    about: '不再向宿主登记 ctx.tools.guard —— 折叠起来的工具就能被直接调用',
    cases: ['PT-HOST-08', 'PT-HOST-17'],
    apply(root) {
      swallowCall(root, 'lib/native.js', 'ctx.tools.guard(')
      swallowCall(root, 'lib/index.js', 'ctx.tools.guard(')
    },
  },
  'no-restrict': {
    about: 'dynamic 模式不再调用 ctx.tools.restrict —— 可见面不收窄',
    cases: [
      'PT-HOST-05', 'PT-HOST-07', 'PT-HOST-19', 'PT-HOST-20', 'PT-HOST-21', 'PT-HOST-22',
      'PT-HOST-24', 'PT-HOST-31', 'PT-HOST-32',
    ],
    apply: root => patch(
      root,
      'lib/index.js',
      'state.agent.ctx.tools.restrict({ allow: [...allow].sort() })',
      '(() => {})',
    ),
  },
  'ignore-tools-change': {
    about: '不再订阅 tools/change —— agent 建好之后注册的工具漏出折叠目录',
    cases: ['PT-HOST-17'],
    apply: root => patch(root, 'lib/index.js', "ctx.on('tools/change'", "ctx.on('tools/change-renamed-upstream'"),
  },
  'legacy-nested-only': {
    about: '只认 0.1 的 tool/code-dispatch,不认 tool/ptc-dispatch',
    cases: ['PT-HOST-32'],
    note: '三个 staged 宿主都已经改用 ptc-dispatch(0.1.5 起),所以三条线都会红。',
    apply: root => patch(
      root,
      'lib/host.js',
      "return type === 'tool/code-dispatch' || type === 'tool/ptc-dispatch';",
      "return type === 'tool/code-dispatch';",
    ),
  },
  'flat-envelope-only': {
    about: '只认 0.2 摊平的 tool-result 信封,不认 0.1 的包裹信封',
    cases: ['PT-HOST-31'],
    note: '0.5 线(0.1.5-rc.2)上必红、0.2 线上必绿 —— 这条差别证明它不是误报。',
    apply: root => patch(
      root,
      'lib/host.js',
      "if (isRecord(first) && first.type === 'tool-result') {",
      'if (false) {',
    ),
  },
  'no-presentation-meta': {
    about: 'native 的发现工具不再声明 output.presentationMeta —— 累计发现表没地方存',
    cases: ['PT-HOST-02', 'PT-HOST-09'],
    apply: root => patch(
      root,
      'lib/native.js',
      /presentationMeta: \(_args, value\) => \(\{ protocol: PROTOCOL[^\n]*\n/,
      '',
    ),
  },
  'peer-0.1-only': {
    about: '把 dsh peer 上界压回 <0.2.0-0 —— 宿主的准入门禁在 0.2 线上直接停用这个插件',
    cases: [
      'PT-HOST-02', 'PT-HOST-03', 'PT-HOST-05', 'PT-HOST-06', 'PT-HOST-07',
      'PT-HOST-08', 'PT-HOST-09', 'PT-HOST-10', 'PT-HOST-11', 'PT-HOST-12', 'PT-HOST-13',
      'PT-HOST-14', 'PT-HOST-15', 'PT-HOST-16', 'PT-HOST-17', 'PT-HOST-18', 'PT-HOST-19',
      'PT-HOST-20', 'PT-HOST-21', 'PT-HOST-22', 'PT-HOST-24', 'PT-HOST-28', 'PT-HOST-31',
      'PT-HOST-32',
    ],
    note: '0.2.0 / 0.2.1 上大面积变红、0.1.5 上一条都不红 —— 复现 T0047 要防的那类事故。'
      + 'PT-HOST-01(模块解析)与 PT-HOST-23/25/26/27/29/30(宿主侧事实与夹具围栏)'
      + '不依赖插件被挂起来,所以不在其中。',
    apply(root) {
      const path = join(root, 'package.json')
      const manifest = JSON.parse(readFileSync(path, 'utf8'))
      for (const [dependency, range] of Object.entries(manifest.peerDependencies ?? {})) {
        if (!dependency.startsWith('@deepseek-ai/dsh')) continue
        manifest.peerDependencies[dependency] = range.replace(/<[^\s]+$/u, '<0.2.0-0')
      }
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
    },
  },
}

/**
 * 施加一个变异。
 * @param {string} root - 装进 profile 的那份包目录。
 * @param {string} mutation - 变异名。
 */
export function mutate(root, mutation) {
  const entry = MUTATIONS[mutation]
  if (entry === undefined) {
    throw new Error(`未知变异 ${JSON.stringify(mutation)};可用的是 ${Object.keys(MUTATIONS).join('、')}`)
  }
  entry.apply(root)
}
