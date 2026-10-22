/**
 * 宿主契约门禁(agent-hub T0047 统一口径)。本仓库所有"对着宿主验"的东西
 * 都收在这一条命令下:
 *
 *   - `PT-HOST-01…32` 真实宿主契约(`tests/live-host.spec.mjs`):宿主自带
 *     launcher 起一次性 profile,真实加载器装入本包发布的文件集,宿主侧不
 *     打桩。
 *   - `PT-COMPAT-01…07` 跨版本边界(`tests/host-contract.spec.ts`):
 *     `src/host.ts` 里那几处"0.1 一种拼法、0.2 另一种"的双向锁定。
 *   - `PT-SMOKE-01` 真实运行时冒烟(`scripts/native-smoke.mjs`):把编译产物
 *     放在宿主完整依赖图上跑一遍,每个配置的宿主各一次。
 *
 *   npm run check:host                     对 DSH_HOST_ROOT 指向的宿主跑全套
 *   npm run check:host -- --list-mutations 列出变异清单
 *   npm run check:host -- --mutate <名字>  把被测路径按名字弄坏,要求指定用例恰好变红
 *   npm run check:host -- --skip-build     跳过 tsc(lib/ 已是最新时)
 *
 * 只认 `DSH_HOST_ROOT`:staged 宿主的 `dsh-plugin-desktop` 目录。本地想一次
 * 跑多个宿主用 `DSH_HOST_ROOTS`(`;` 分隔);本仓库原有的 `DSH_TEST_RUNTIME`
 * (指向宿主 package.json)继续认,内部折算成同一个根。产品门禁只传
 * `DSH_HOST_ROOT`。
 *
 * 没有宿主时每条用例显式报 NOT EXECUTED 并以非 0 退出 —— 不伪造通过。
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MUTATIONS } from '../tests/support/mutations.mjs'
import { hostRoots, hostRuntimeVersion } from '../tests/support/live-host.mjs'

const SPECS = ['tests/live-host.spec.mjs', 'tests/host-contract.spec.ts']
const CASE_ID = /^(PT-(?:HOST|GUARD|COMPAT)-\d+)\b/

function listMutations() {
  console.log('变异清单(--mutate <名字>):\n')
  for (const [mutationName, entry] of Object.entries(MUTATIONS)) {
    console.log(`  ${mutationName}`)
    console.log(`    ${entry.about}`)
    console.log(`    期望变红:${entry.cases.join('、')}`)
    if (entry.note !== undefined) console.log(`    说明:${entry.note}`)
  }
}

function parseArgs(argv) {
  const options = { mutation: undefined, list: false, build: true }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--list-mutations') options.list = true
    else if (argument === '--skip-build') options.build = false
    else if (argument === '--mutate') {
      index += 1
      options.mutation = argv[index]
    } else if (argument.startsWith('--mutate=')) options.mutation = argument.slice('--mutate='.length)
    else {
      console.error(`未知参数 ${JSON.stringify(argument)}`)
      process.exit(2)
    }
  }
  return options
}

/** 跑一次 vitest,回来一张「用例编号 → 状态」的表。 */
function runSuite(env) {
  const scratch = mkdtempSync(join(tmpdir(), 'progressive-tools-check-host-'))
  const outputFile = join(scratch, 'result.json')
  try {
    const run = spawnSync(
      'npx',
      ['vitest', 'run', ...SPECS, '--reporter=json', '--reporter=default', '--no-file-parallelism', `--outputFile.json=${outputFile}`],
      { stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...env } },
    )
    let parsed
    try {
      parsed = JSON.parse(readFileSync(outputFile, 'utf8'))
    } catch {
      return { status: run.status ?? 1, cases: undefined }
    }
    const cases = new Map()
    for (const file of parsed.testResults ?? []) {
      for (const assertion of file.assertionResults ?? []) {
        const id = CASE_ID.exec(assertion.title ?? '')?.[1]
        if (id === undefined) continue
        // `it.each` 会让同一个编号出现多次:只要有一次红,这个编号就算红。
        const previous = cases.get(id)
        if (previous?.status === 'failed') continue
        cases.set(id, { status: assertion.status, title: assertion.title })
      }
    }
    return { status: run.status ?? 1, cases }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** 把编译产物放到宿主完整依赖图上跑一遍 —— 本仓库原有的真实运行时冒烟。 */
function runNativeSmoke(roots) {
  const failures = []
  for (const root of roots) {
    const run = spawnSync(
      process.execPath,
      ['--import', './scripts/runtime-loader.mjs', 'scripts/native-smoke.mjs'],
      { stdio: 'inherit', env: { ...process.env, DSH_TEST_RUNTIME: join(root, 'package.json') } },
    )
    if (run.status !== 0) failures.push(`${hostRuntimeVersion(root)}(${root})`)
  }
  return failures
}

const options = parseArgs(process.argv.slice(2))
if (options.list) {
  listMutations()
  process.exit(0)
}
if (options.mutation !== undefined && MUTATIONS[options.mutation] === undefined) {
  console.error(`未知变异 ${JSON.stringify(options.mutation)};用 --list-mutations 看清单`)
  process.exit(2)
}

const roots = hostRoots()
if (roots.length === 0) {
  console.error('')
  console.error('NOT EXECUTED —— 真实宿主契约一条都没跑。')
  console.error('  需要 DSH_HOST_ROOT 指向 staged 宿主的 dsh-plugin-desktop 目录,')
  console.error('  例如 <TokensCowork>/.build/desktop/dsh-plugin-desktop。')
  console.error('  本地要一次跑多个宿主,用 ";" 分隔的 DSH_HOST_ROOTS。')
  console.error('')
  // 跑一遍把每条没执行的用例逐条列出来,再以非 0 退出 —— 不伪造通过。
  const dryRun = runSuite({})
  const notExecuted = [...(dryRun.cases ?? new Map()).entries()]
    .filter(([, entry]) => entry.status !== 'passed' && entry.status !== 'failed')
  console.error('\nNOT EXECUTED 清单:')
  for (const [, entry] of notExecuted) console.error(`  ${entry.title}`)
  console.error(`\n共 ${notExecuted.length} 条未执行。`)
  process.exit(1)
}

console.log('宿主契约:')
for (const root of roots) console.log(`  dsh ${hostRuntimeVersion(root)}  ${root}`)
if (options.mutation !== undefined) {
  console.log(`变异:${options.mutation} —— ${MUTATIONS[options.mutation].about}`)
}
console.log('')

// 装进真实宿主的是 `lib/` 里的编译产物,所以先编译一次:忘了编译会让整套
// 用例测的是上一次的代码,而且全绿。
if (options.build) {
  const built = spawnSync('npx', ['tsc', '-p', 'tsconfig.build.json'], {
    stdio: 'inherit', shell: process.platform === 'win32',
  })
  if (built.status !== 0) {
    console.error('tsc 失败,不继续 —— 装进宿主的会是过期产物。')
    process.exit(built.status ?? 1)
  }
}

const result = runSuite(
  options.mutation === undefined ? {} : { PROGRESSIVE_TOOLS_MUTATION: options.mutation },
)

if (result.cases === undefined) {
  console.error('\n没拿到 vitest 的结果文件;按失败处理。')
  process.exit(result.status === 0 ? 1 : result.status)
}

const failed = [...result.cases.entries()].filter(([, entry]) => entry.status === 'failed').map(([id]) => id).sort()
const skipped = [...result.cases.entries()].filter(([, entry]) => entry.status !== 'passed' && entry.status !== 'failed')

if (skipped.length > 0) {
  console.error('\nNOT EXECUTED:')
  for (const [, entry] of skipped) console.error(`  ${entry.title}`)
}

if (options.mutation === undefined) {
  if (failed.length > 0 || skipped.length > 0) process.exit(result.status === 0 ? 1 : result.status)
  // 变异验证时跳过冒烟:它不参与编号对照,红了会把判定搅浑。
  const smokeFailures = runNativeSmoke(roots)
  if (smokeFailures.length > 0) {
    console.error(`\nPT-SMOKE-01 真实运行时冒烟失败:${smokeFailures.join('、')}`)
    process.exit(1)
  }
  console.log(`\n宿主契约全部通过(${result.cases.size} 条编号用例 + PT-SMOKE-01 × ${roots.length} 个宿主)。`)
  process.exit(0)
}

// 变异验证:要求指定的用例**恰好**变红。多红说明用例之间互相牵连,少红说明
// 那条用例是空转 —— 两种都算验证失败。
const expected = [...MUTATIONS[options.mutation].cases].sort()
const missing = expected.filter(id => !failed.includes(id))
const extra = failed.filter(id => !expected.includes(id))
console.log(`\n变异 ${options.mutation}:期望变红 ${expected.join('、') || '(无)'}`)
console.log(`               实际变红 ${failed.join('、') || '(无)'}`)
if (missing.length === 0 && extra.length === 0) {
  console.log('变异验证 PASS —— 被测路径弄坏后,恰好是这些用例变红。')
  process.exit(0)
}
if (missing.length > 0) console.error(`应红却没红(可能是空转用例):${missing.join('、')}`)
if (extra.length > 0) console.error(`不该红却红了(用例互相牵连):${extra.join('、')}`)
process.exit(1)
