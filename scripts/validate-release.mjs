import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const registry = 'https://npm.tokensapi.ai/'
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function remoteRepository() {
  const remote = execFileSync('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim()
  const match = remote.match(/github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/i)
  if (!match) throw new Error(`Cannot determine GitHub repository from origin: ${remote}`)
  return match[1]
}

export function validateRelease(manifest, tag, repository = process.env.GITHUB_REPOSITORY ?? remoteRepository()) {
  if (!manifest.name || !manifest.repository?.url) throw new Error('Package name and repository URL are required')
  if (manifest.publishConfig?.registry !== registry) throw new Error(`Release must target ${registry}`)
  if (!stableVersion.test(manifest.version)) throw new Error('Only stable versions may update latest')
  if (tag !== `v${manifest.version}`) throw new Error('Release tag must match package.json version')
  if (repository !== remoteRepository()) throw new Error(`GitHub repository ${repository} does not match origin ${remoteRepository()}`)
  if (!manifest.repository.url.includes(repository.split('/')[1])) throw new Error('Package repository URL does not match the GitHub repository')
  return { name: manifest.name, version: manifest.version, repository }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const result = validateRelease(manifest, process.argv[2])
  console.log(`Validated ${result.name}@${result.version} for ${registry} from ${result.repository}`)
}
