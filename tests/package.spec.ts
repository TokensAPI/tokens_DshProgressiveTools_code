import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { DEFAULT_ALWAYS_VISIBLE } from '../src/defaults.js'
import { name } from '../src/index.js'

const NPMJS_PUBLISH = /npm publish .*registry\.npmjs\.org/
const PACK_IGNORE_SCRIPTS = /pnpm pack .*--ignore-scripts/

describe('Tokens package contract', () => {
  it('keeps package, loader patch, and plugin identities aligned', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      name: string
      version: string
      description: string
      repository: { type: string; url: string }
      license: string
      tokenscowork: {
        displayName: { 'zh-CN': string; 'en-US': string }
        summary: { 'zh-CN': string; 'en-US': string }
      }
      scripts: Record<string, string>
      devDependencies: Record<string, string>
      peerDependencies: Record<string, string>
      dsh: { engine: string; bundle: { patch: string } }
      publishConfig: { access: string; registry: string }
      engines: { node: string }
    }
    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    const checks = await readFile(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8')
    const release = await readFile(new URL('../.github/workflows/publish-npm.yml', import.meta.url), 'utf8')
    const changelog = await readFile(new URL('../docs/CHANGELOG.md', import.meta.url), 'utf8')

    expect(manifest.name).toBe('@tokensapi/dsh-progressive-tools')
    // 不钉字面版本号:那样每次 bump 都会假失败,而假失败正好发生在发布路上。
    // 真正要保的是版本号形状合法,且变更记录里确实有这一版的小节。
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/)
    expect(changelog).toContain(`## [Tokens ${manifest.version}]`)
    expect(manifest.description).toBeTruthy()
    expect(manifest.repository).toMatchObject({ type: 'git' })
    expect(manifest.license).toBe('MIT')
    expect(manifest.publishConfig).toEqual({ access: 'public', registry: 'https://npm.tokensapi.ai/' })
    expect(checks).toContain('name: Checks')
    // 一个发布版要同时服务两条产品线,所以检查必须在两个在用的运行时上各跑一遍:
    // 开发基线是 0.6 的 0.2.0-rc.2,这条腿把开发依赖重钉到 0.5 的 0.1.5-rc.2。
    // 少了它,只在一条线上成立的改动会静悄悄通过 —— 这正是 0.2.5 那两个缺陷
    // 漏到用户手里的方式。
    expect(manifest.scripts['check:dsh-0.1']).toBe('node scripts/with-dsh-runtime.mjs 0.1.5-rc.2 4.0.2 typecheck test build test:runtime')
    // 两条腿都要跑真实依赖图上的 smoke:单元用例用的是夹具,只有它会把编译产物
    // 装进该运行时真正的依赖图里跑一遍。
    expect(manifest.scripts.check).toContain('pnpm run test:runtime')
    expect(checks).toContain('pnpm run check:dsh-0.1')
    // 开发基线必须是当前产品在跑的运行时,而且所有 DSH 开发依赖同一个版本,否则
    // 装出来的是一个没人发布过的混合运行时。`check:dsh-0.1` 临时重钉时按它的版本核对。
    const dshBaseline = process.env.DSH_RUNTIME_PIN ?? '0.2.0-rc.2'
    expect(Object.entries(manifest.devDependencies)
      .filter(([pkg]) => pkg.startsWith('@deepseek-ai/dsh'))
      .filter(([, version]) => version !== dshBaseline)).toEqual([])
    expect(release).toContain('name: Publish to private npm')
    expect(release).toContain('https://npm.tokensapi.ai/')
    expect(release).toContain('VERDACCIO_PUBLISH_TOKEN')
    expect(release).not.toMatch(NPMJS_PUBLISH)
    // Both workflows cover the whole engines range. needs cannot span
    // workflows, so the release gates on a matrix it runs itself.
    expect(manifest.engines.node).toBe('^22.19.0 || >=24.0.0')
    expect(checks).toContain('node: [22.19.0, 24]')
    expect(release).toContain('node: [22.19.0, 24]')
    expect(release).toContain('needs: check')
    // Disjoint triggers: checks skip tags, the release runs on nothing else.
    // Without that split a tag would run both, and the release could publish
    // while the other workflow was still checking.
    expect(checks).toContain("branches: ['**']")
    expect(release).toContain("tags: ['v*']")
    expect(release).toContain("if: startsWith(github.ref, 'refs/tags/v')")
    // A manual entry would take a different concurrency key and could publish
    // the same version in parallel.
    expect(release).not.toContain('workflow_dispatch')
    // An unreachable or unauthorized registry must abort instead of reading as
    // "version not published yet".
    expect(release).toContain('*E404*')
    expect(release).toContain('Cannot confirm that')
    // A missing read-only checker secret skips the post-publish package check instead of
    // blocking the release; a configured one must still be the market account.
    expect(release).toContain("if: needs.publish.outputs.package-check == 'true'")
    expect(release).toContain('package-check: ${{ steps.checker.outputs.enabled }}')
    expect(release).toContain("echo 'enabled=false' >> \"$GITHUB_OUTPUT\"")
    expect(release).not.toContain('请配置只读 Secret')
    // pnpm pack rejects --ignore-scripts as an unknown option, which would
    // abort the release before anything is published.
    expect(release).not.toMatch(PACK_IGNORE_SCRIPTS)
    expect(manifest.tokenscowork).toEqual({
      displayName: {
        'zh-CN': '渐进式工具',
        'en-US': 'Progressive Tools',
      },
      summary: {
        'zh-CN': '只让高频工具常驻模型上下文，其余工具按需搜索并通过原有 DSH 安全执行链分发。',
        'en-US': 'Keep frequently used tools in context, discover others on demand, and execute them through the standard DSH safety pipeline.',
      },
    })
    // DSH 0.2 起,宿主在启动时只按这些 peer 判断插件能不能加载,并且用
    // includePrerelease 解析范围。手写区间是唯一能同时放过 0.5 的 0.1.5-rc.2
    // 和 0.6 的 0.2.0-rc.2 的写法:`^0.1.x` / `~0.1.x` 会被 semver 补上
    // `<0.2.0-0` 上界,装进 0.6 就直接被停用。上界停在没核对过的 0.3。
    const dshRuntimeRange = '>=0.1.0-rc.8 <0.3.0-0'
    expect(manifest.peerDependencies).toMatchObject({
      '@deepseek-ai/cordis': '4.0.1 || 4.0.2 || 4.0.4',
      '@deepseek-ai/dsh-agent': dshRuntimeRange,
      '@deepseek-ai/dsh-llm': dshRuntimeRange,
      '@deepseek-ai/dsh-session': dshRuntimeRange,
      '@deepseek-ai/dsh-system-prompt': dshRuntimeRange,
      '@deepseek-ai/dsh-tools': dshRuntimeRange,
    })
    // 宿主检查每一个 `@deepseek-ai/dsh*` peer,有一个不覆盖当前运行时就停用整个
    // 插件。所以新增 peer 也必须用同一个区间,这里按名字前缀兜住,而不是逐个点名。
    expect(Object.entries(manifest.peerDependencies)
      .filter(([pkg]) => pkg === '@deepseek-ai/dsh' || pkg.startsWith('@deepseek-ai/dsh-'))
      .filter(([, range]) => range !== dshRuntimeRange)).toEqual([])
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    // dsh.engine 声明目标 DSH 运行时范围。这里不硬编码字面量,而是钉住它与
    // 核心 peer 同源:两者一旦分叉,就是"声明支持某运行时却没有对应的 peer"。
    expect(manifest.dsh.engine).toBe(manifest.peerDependencies['@deepseek-ai/dsh-tools'])
    expect(name).toBe('tokens-progressive-tools')
    expect(patch).toContain('id: tokens-progressive-tools')
    expect(patch).toContain("name: '@tokensapi/dsh-progressive-tools'")
  })

  it('ships without install lifecycle scripts', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
    }
    const installLifecycle = ['preinstall', 'install', 'postinstall', 'prepare']

    expect(installLifecycle.filter(script => Object.hasOwn(manifest.scripts, script))).toEqual([])
    expect(manifest.scripts.prepack).toBe('pnpm run check')
  })

  it('does not import the legacy call ID constructor at runtime', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')

    expect(source).not.toMatch(
      /import\s+\{[^}]*\bCallId\b[^}]*\}\s+from\s+['"]@deepseek-ai\/dsh-llm['"]/s,
    )
  })

  it('keeps the Tokens high-frequency safety surface directly callable', () => {
    expect(DEFAULT_ALWAYS_VISIBLE).toEqual(expect.arrayContaining([
      'read',
      'write',
      'edit',
      'glob',
      'grep',
      'bash',
      'skill',
      'ask_user_question',
      'todo_write',
      'dsh_im_return_file',
    ]))
  })

  // The market reads `tokenscowork`; the dsh Plugins page reads only `locale/<lang>.json`.
  it('ships the market metadata as dsh locale files too', async () => {
    const read = async (path: string) => JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'))
    const manifest = await read('package.json')
    const metas = []
    for (const [lang, key] of [['en', 'en-US'], ['zh', 'zh-CN']] as const) {
      const { meta } = await read(`locale/${lang}.json`)
      expect(meta).toEqual({ title: manifest.tokenscowork.displayName[key], description: manifest.tokenscowork.summary[key] })
      metas.push(meta)
    }
    expect(metas[0].title).not.toBe(metas[1].title)
    expect(metas[0].description).not.toBe(metas[1].description)
    expect(manifest.exports).toMatchObject({ './package.json': './package.json', './locale/*.json': './locale/*.json' })
    const [{ files }] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'ignore'],
    })) as [{ files: { path: string }[] }]
    expect(files.map(({ path }) => path)).toEqual(expect.arrayContaining(['package.json', 'locale/en.json', 'locale/zh.json']))
  }, 60_000)
})
