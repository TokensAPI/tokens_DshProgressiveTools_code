/* ============================================================
 * 把这个插件装进一个真实宿主,然后在里面跑
 * ============================================================
 * 本仓库别的用例都自己供宿主:`tests/*.spec.ts` 用开发依赖里的 DSH 包手搭
 * 一个 Context,`scripts/native-smoke.mjs` 用 resolve hook 把 `@deepseek-ai/*`
 * 指到 staged 宿主。两种都只覆盖"插件自己调得通",覆盖不到"真实宿主把它
 * 装进去之后还成立" —— DSH 0.2.1 把网关 `peer` 从可选改必填,连接中心在四个
 * 产品版本上全坏,而它三千多条打桩用例一路全绿(agent-hub T0043 / T0047)。
 *
 * 所以这一组宿主侧**一个桩都不打**:用宿主自带的 launcher 起一个一次性
 * `$DSH_HOME` profile(bundle = `@deepseek-ai/dsh-base` + 本包),由**真实
 * 加载器**按本包自己的 `cordis.patch.yml` 把 `@tokensapi/dsh-progressive-tools`
 * 挂进去,再由宿主真实的 `ctx.agents` 工厂造一个真实 Agent(真实 session、
 * 真实工具注册表、真实执行管线、真实 system prompt 装配)。
 *
 * 装进去的是**本包 `files` 白名单声明的那份文件集**,不是整个工作区 ——
 * 于是这组用例顺带钉住了"发布出去的那份包真的能被宿主加载"。
 *
 * 本插件有三种模式(native / stable-proxy / dynamic),它们对宿主的调用面
 * 不同(只有 stable-proxy 走嵌套 `tools.execute`,只有 dynamic 用
 * `tools.restrict` 和 `agent/pre-step`),而三者的守卫与工具名在同一棵树上
 * 会互相干扰,所以**每种模式各起一次宿主**。
 *
 * 夹具安全(T0047 口径 3):`$DSH_HOME` 一律 `mkdtemp`,探针把它实际看到的
 * 每个路径回报上来,用例逐个断言落在临时目录内;另外比对用户真实 `~/.dsh`
 * 顶层条目的大小与 mtime 前后不变 —— 联网搜索那次把用户真实 settings.yaml
 * 改成测试值,就是因为没人断言路径。
 * ============================================================ */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { MUTATIONS, mutate } from './mutations.mjs'
import { MODES, modeProfileConfig } from './live-host-modes.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..')
const PROBE_URL = pathToFileURL(join(here, 'live-host-probe.mjs')).href
const PROBE_PACKAGE = 'tokens-progressive-tools-live-probe'
const PROFILE = 'progressive-tools-host-contract'
/** 本包的 npm 包名,也是真实加载器要解析的那个名字。 */
export const PACKAGE_NAME = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).name
/** 本包 `cordis.patch.yml` 给自己那一行用的 id —— 覆盖配置要按 id 寻址。 */
const ROW_ID = 'tokens-progressive-tools'
/** 起一个完整宿主不便宜;冷启动慢不等于失败。 */
const BOOT_TIMEOUT_MS = 240_000

export { MODES }

/**
 * 要跑的 staged 宿主根(`dsh-plugin-desktop` 目录)。
 *
 * 对外只认 `DSH_HOST_ROOT`(T0047 统一口径);`DSH_HOST_ROOTS` 用 `;` 分隔,
 * 一次跑完三条产品线。`DSH_TEST_RUNTIME` 是本仓库原有的名字(指向宿主的
 * `package.json`,`scripts/runtime-loader.mjs` 在用),继续认下来,内部统一
 * 折算成"宿主根目录"。
 * @returns {string[]} 配置顺序的宿主根列表。
 */
export function hostRoots() {
  const configured = process.env.DSH_HOST_ROOTS ?? process.env.DSH_HOST_ROOT ?? ''
  const roots = configured.split(';').map(entry => entry.trim()).filter(entry => entry !== '')
  if (roots.length > 0) return roots.map(entry => resolve(entry))
  const legacy = (process.env.DSH_TEST_RUNTIME ?? '').trim()
  return legacy === '' ? [] : [dirname(resolve(legacy))]
}

/** 没有配置宿主时的说明;配了至少一个则为 false。 */
export const SKIP_WITHOUT_HOST = hostRoots().length > 0
  ? false
  : 'NOT EXECUTED: 需要 DSH_HOST_ROOT 指向 staged 宿主的 dsh-plugin-desktop 目录'
    + '(多个宿主用 DSH_HOST_ROOTS,";" 分隔)'

/**
 * 从宿主根解析一个包 —— 所有"宿主自己的事实"都从这里取。
 * @param {string} root - 宿主根目录。
 * @returns {NodeRequire}
 */
export function hostRequire(root) {
  return createRequire(join(resolve(root), 'package.json'))
}

/**
 * 宿主自己带的 DSH 运行时版本。
 * @param {string} root - 宿主根目录。
 * @returns {string}
 */
export function hostRuntimeVersion(root) {
  return JSON.parse(readFileSync(hostRequire(root).resolve('@deepseek-ai/dsh/package.json'), 'utf8')).version
}

/** 宿主自带的 launcher。 */
function hostLauncher(root) {
  return resolve(hostRequire(root).resolve('@deepseek-ai/dsh/package.json'), '..', 'lib/bin.js')
}

/** 用户真实的 DSH 家目录 —— 夹具断言"一个字节都没碰到这里"时的对照。 */
export const REAL_DSH_HOME = join(homedir(), '.dsh')

/**
 * 路径包含判断:大小写与分隔符按本平台来,不做字符串前缀的近似。
 *
 * 夹具安全那条断言全靠它,所以它自己也有用例(`live-host.spec.mjs` 的
 * PT-GUARD 组)—— 一个恒真的 `inside()` 会让围栏变成装饰品。
 * @param {string} child - 被检查的路径。
 * @param {string} parent - 期望的上级目录。
 * @returns {boolean}
 */
export function inside(child, parent) {
  const normal = value => (process.platform === 'win32' ? value.toLowerCase() : value)
  const base = normal(parent).replace(/[\\/]+$/u, '')
  const target = normal(child)
  return target === base || target.startsWith(`${base}${sep}`)
}

/**
 * 用户真实 `~/.dsh` 的一张浅快照:顶层条目的大小与 mtime。
 *
 * 启动前后各取一次,用例要求两次完全相同 —— 断言路径只能证明"我们以为写在
 * 临时目录",这一条才能证明"用户的目录确实没被动过"。不递归:会话目录可能
 * 很大,而出过事的那一类(settings.yaml 被改成测试值)就在顶层。
 * @returns {Record<string, object>} 条目名 → `{ size, mtimeMs }`,目录不存在时为空对象。
 */
export function realHomeSnapshot() {
  const snapshot = {}
  let entries
  try {
    entries = readdirSync(REAL_DSH_HOME, { withFileTypes: true })
  } catch {
    return snapshot
  }
  for (const entry of entries) {
    try {
      const info = statSync(join(REAL_DSH_HOME, entry.name))
      snapshot[entry.name] = { size: entry.isFile() ? info.size : undefined, mtimeMs: info.mtimeMs }
    } catch {
      snapshot[entry.name] = { unreadable: true }
    }
  }
  return snapshot
}

/** `files` 白名单声明的、真正发布出去的那份文件集(npm 无条件带上 LICENSE)。 */
const PUBLISHED_ENTRIES = ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'lib', 'docs', 'locale']

/**
 * 把本包发布的那份文件集装进 profile 的 `node_modules`。
 *
 * `node_modules/@deepseek-ai` 整体 symlink 到宿主那一份:插件必须解析到
 * **宿主的**运行时包(它们用 module-local Symbol,多一份物理副本就对不上
 * 服务),同时本包唯一的第三方依赖 `@deepseek-ai/schemastery` 也落在那里 ——
 * 与真实安装里 pnpm 去重后的结果一致。不能把宿主的 `node_modules` 整体
 * junction 到 profile 前面:那会让加载器优先解析到宿主自带的同名副本
 * (T0047-A 登录插件踩过)。
 * @param {string} profile - profile 目录。
 * @param {string} root - 宿主根目录。
 * @param {string | undefined} mutation - 要施加的变异名;不给则装原样。
 * @returns {string} 装进去的那份包目录。
 */
function installPackage(profile, root, mutation) {
  const modules = join(profile, 'node_modules')
  const [scope, bare] = PACKAGE_NAME.split('/')
  const installed = join(modules, scope, bare)
  mkdirSync(installed, { recursive: true })
  for (const entry of PUBLISHED_ENTRIES) cpSync(join(repo, entry), join(installed, entry), { recursive: true })
  if (mutation !== undefined) mutate(installed, mutation)
  symlinkSync(join(resolve(root), 'node_modules', '@deepseek-ai'), join(modules, '@deepseek-ai'),
    process.platform === 'win32' ? 'junction' : 'dir')
  return installed
}

/** 探针作为一个单行包装包挂进 profile,这样它 import 的是本仓库自己的模块。 */
function installProbe(home) {
  const probe = join(home, 'node_modules', PROBE_PACKAGE)
  mkdirSync(probe, { recursive: true })
  writeFileSync(join(probe, 'package.json'), `${JSON.stringify({
    name: PROBE_PACKAGE,
    version: '0.0.0',
    private: true,
    type: 'module',
    main: 'index.mjs',
    exports: { '.': './index.mjs' },
  }, null, 2)}\n`)
  writeFileSync(join(probe, 'index.mjs'), `export * from ${JSON.stringify(PROBE_URL)};\n`)
}

/** 一行 YAML 值;配置整体用 JSON 写(YAML 是 JSON 的超集,免得自己拼缩进)。 */
const yamlJson = value => JSON.stringify(value)

/**
 * 铺一个一次性的 `$DSH_HOME`:本包发布的文件集 + 探针 + 一个把两者叠在宿主
 * 自己 bundle 之上的 profile。
 * @param {string} root - 宿主根目录。
 * @param {string} mode - 本次要测的插件模式。
 * @param {string | undefined} mutation - 变异名;不给则装原样。
 * @returns {{ home: string, profile: string, installed: string }}
 */
function composeHome(root, mode, mutation) {
  const home = mkdtempSync(join(tmpdir(), 'progressive-tools-live-'))
  installProbe(home)

  // native 走本包自己的 bundle patch —— 也就是发布出去的那份默认形态,
  // 顺带钉住"published 的 `cordis.patch.yml` 真能被宿主加载器应用"。
  // 另外两种模式要给配置,改由 profile 自己的 patch 层插同一个包:DSH 0.1.5
  // 的加载器**拒绝重复的 entry id**(0.2 是后写覆盖),所以不能两层都插。
  const config = modeProfileConfig(mode)
  const bundles = config === undefined
    ? ['@deepseek-ai/dsh-base', PACKAGE_NAME]
    : ['@deepseek-ai/dsh-base']

  const profile = join(home, 'profiles', PROFILE)
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${PROFILE}`,
    private: true,
    dsh: { profile: { bundles } },
  }, null, 2)}\n`)
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')

  writeFileSync(join(profile, 'cordis.patch.yml'), [
    '- insert:',
    `    - id: ${PROBE_PACKAGE}`,
    `      name: ${PROBE_PACKAGE}`,
    ...(config === undefined ? [] : [
      `    - id: ${ROW_ID}`,
      `      name: ${yamlJson(PACKAGE_NAME)}`,
      `      config: ${yamlJson(config)}`,
    ]),
    '',
  ].join('\n'))

  const installed = installPackage(profile, root, mutation)
  return { home, profile, installed }
}

function launch(root, home, mode, report) {
  return new Promise((settle) => {
    const child = spawn(process.execPath, [hostLauncher(root), '--profile', PROFILE], {
      cwd: home,
      env: {
        ...process.env,
        DSH_HOME: home,
        PROGRESSIVE_TOOLS_LIVE_REPORT: report,
        PROGRESSIVE_TOOLS_LIVE_HOST_ROOT: resolve(root),
        PROGRESSIVE_TOOLS_LIVE_PROFILE_DIR: join(home, 'profiles', PROFILE),
        PROGRESSIVE_TOOLS_LIVE_PACKAGE: PACKAGE_NAME,
        PROGRESSIVE_TOOLS_LIVE_MODE: mode,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const collect = (chunk) => {
      output += chunk
      // 失控的宿主否则会把整份日志攒进这个字符串。
      if (output.length > 200_000) output = output.slice(-200_000)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle({ output, timedOut: true })
    }, BOOT_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      settle({ output: `${output}\n${error.message}`, spawnFailed: true })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      settle({ output, code })
    })
  })
}

/**
 * 起一个宿主跑一种模式,跑完探针,回收临时目录。
 * @param {string} root - 宿主根目录。
 * @param {string} mode - 插件模式。
 * @param {string | undefined} mutation - 变异名;不给则装原样。
 * @returns {Promise<object>} 一份报告。
 */
export async function bootOne(root, mode, mutation) {
  const { home, profile } = composeHome(root, mode, mutation)
  const reportPath = join(home, 'live-report.json')
  const realHomeBefore = realHomeSnapshot()
  const run = await launch(root, home, mode, reportPath)
  const realHomeAfter = realHomeSnapshot()
  let parsed
  try {
    parsed = JSON.parse(readFileSync(reportPath, 'utf8'))
  } catch {
    parsed = undefined
  }
  let realHome
  try {
    realHome = realpathSync(home)
  } catch {
    realHome = home
  }
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 })
  } catch { /* 还在退出的宿主可能占着句柄;临时目录本来就是一次性的。 */ }
  return {
    root: resolve(root),
    version: hostRuntimeVersion(root),
    mode,
    mutation,
    home,
    realHome,
    profile,
    realHomeBefore,
    realHomeAfter,
    booted: parsed !== undefined,
    steps: parsed?.steps ?? [],
    fatal: parsed?.fatal,
    probeEnv: parsed?.env,
    launcher: run,
  }
}

let booted

/**
 * 每个测试进程把每个「宿主 × 模式」启动一次,**串行** —— 本机内存紧,两个
 * 宿主同时起过会把整个套件带下去。
 * @returns {Promise<object[]>} 按 宿主 × 模式 顺序的报告。
 */
export function liveHostReports() {
  booted ??= (async () => {
    // 有效性复核时由 `check:host --mutate` 设这个变量:同一套用例跑在被
    // 故意弄坏的那份副本上,指定的那几条必须红。
    const raw = process.env.PROGRESSIVE_TOOLS_MUTATION
    const mutation = raw === undefined || raw === '' ? undefined : raw
    const reports = []
    for (const root of hostRoots()) {
      for (const mode of MODES) reports.push(await bootOne(root, mode, mutation))
    }
    return reports
  })()
  return booted
}

/** 某一种模式的那几份报告(每个宿主一份)。 */
export const reportsForMode = (reports, mode) => reports.filter(report => report.mode === mode)

/**
 * 探针记录的一步。
 * @param {object} report - liveHostReports 的一项。
 * @param {string} id - 步骤 id。
 * @returns {object} 该步;探针没走到就抛,并把宿主自己的说法带上。
 */
export function liveStep(report, id) {
  if (!report.booted) {
    throw new Error(`宿主 ${report.version}(${report.mode})没有回报;launcher 说:\n${
      (report.launcher.output ?? '').slice(-6000)}`)
  }
  const step = report.steps.find(entry => entry.id === id)
  if (step === undefined) {
    throw new Error(`探针在 ${report.version}(${report.mode})上没走到 ${id};它记录了 ${
      report.steps.map(entry => entry.id).join('、') || '什么都没有'
    }${report.fatal === undefined ? '' : `,并以 ${JSON.stringify(report.fatal, null, 2)} 失败`}`)
  }
  return step
}

/**
 * 断言某一步成功,失败时报出宿主自己的错误。
 * @param {object} report - liveHostReports 的一项。
 * @param {string} id - 步骤 id。
 * @returns {unknown} 该步记录的值。
 */
export function liveValue(report, id) {
  const step = liveStep(report, id)
  if (!step.ok) {
    throw new Error(`${id} 在真实宿主 ${report.version}(${report.mode})上失败:${
      JSON.stringify(step.error, null, 2)}`)
  }
  return step.value
}

/**
 * 同一条断言对每份报告各跑一次,失败时点名是哪个宿主、哪种模式。
 * @param {object[]} reports - 要检查的报告。
 * @param {(report: object) => void} check - 每份报告调一次。
 */
export function forEachHost(reports, check) {
  if (reports.length === 0) throw new Error('没有任何宿主报告可检查')
  for (const report of reports) {
    try {
      check(report)
    } catch (error) {
      error.message = `宿主 ${report.version} / 模式 ${report.mode}:${error.message}`
      throw error
    }
  }
}

export { MUTATIONS }
