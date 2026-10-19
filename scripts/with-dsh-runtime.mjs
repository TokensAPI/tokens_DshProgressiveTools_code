/**
 * Run package scripts against a DSH runtime other than the development
 * baseline, then put the manifest, overrides and lockfile back.
 *
 * One published version serves every runtime the `peerDependencies` range
 * claims, so the checks have to run on more than one of them. The development
 * baseline is the runtime the current product ships; this script covers the
 * other supported line without a second checkout.
 *
 * Usage: node scripts/with-dsh-runtime.mjs <dsh version> <cordis version> <script>...
 * Example: node scripts/with-dsh-runtime.mjs 0.1.5-rc.2 4.0.2 typecheck test build
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const [dshVersion, cordisVersion, ...scripts] = process.argv.slice(2)
if (dshVersion === undefined || cordisVersion === undefined || scripts.length === 0) {
  console.error('usage: node scripts/with-dsh-runtime.mjs <dsh version> <cordis version> <script>...')
  process.exit(2)
}

const FILES = ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']
const saved = new Map(FILES.map(file => [file, readFileSync(file)]))

/** Install every `@deepseek-ai/dsh*` development dependency at one version. */
function pin() {
  const manifest = JSON.parse(saved.get('package.json').toString('utf8'))
  for (const name of Object.keys(manifest.devDependencies)) {
    if (name.startsWith('@deepseek-ai/dsh')) manifest.devDependencies[name] = dshVersion
  }
  manifest.devDependencies['@deepseek-ai/cordis'] = cordisVersion
  writeFileSync('package.json', `${JSON.stringify(manifest, null, 2)}\n`)
  const baseline = JSON.parse(saved.get('package.json').toString('utf8')).devDependencies['@deepseek-ai/dsh-tools']
  writeFileSync('pnpm-workspace.yaml', saved.get('pnpm-workspace.yaml').toString('utf8').replaceAll(baseline, dshVersion))
}

// The package contract case pins the development baseline to the runtime the
// current product ships; while this script holds another runtime pinned, that
// case checks against the pin instead.
const run = (command, args, pinned = false) => spawnSync(command, args, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: pinned ? { ...process.env, DSH_RUNTIME_PIN: dshVersion } : process.env,
})

let status = 0
try {
  pin()
  const installed = run('pnpm', ['install', '--no-frozen-lockfile', '--ignore-scripts'])
  status = installed.status ?? 1
  for (const script of scripts) {
    if (status !== 0) break
    console.log(`\n=== dsh ${dshVersion}: pnpm run ${script} ===`)
    status = run('pnpm', ['run', script], true).status ?? 1
  }
} finally {
  for (const [file, contents] of saved) writeFileSync(file, contents)
  // Leave the baseline installed, so a local run does not strand the
  // node_modules tree on the runtime this script pinned.
  run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'])
}

process.exit(status)
