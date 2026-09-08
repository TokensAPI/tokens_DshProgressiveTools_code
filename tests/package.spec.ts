import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { DEFAULT_ALWAYS_VISIBLE } from '../src/defaults.js'
import { name } from '../src/index.js'

describe('Tokens package contract', () => {
  it('keeps package, loader patch, and plugin identities aligned', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      name: string
      version: string
      scripts: Record<string, string>
      peerDependencies: Record<string, string>
      dsh: { bundle: { patch: string } }
    }
    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

    expect(manifest.name).toBe('@tokensapi/dsh-progressive-tools')
    expect(manifest.version).toBe('0.1.3')
    expect(manifest.peerDependencies).toMatchObject({
      '@deepseek-ai/cordis': '4.0.1 || 4.0.2',
      '@deepseek-ai/dsh-agent': '0.1.0-rc.8 || 0.1.3-alpha.1',
      '@deepseek-ai/dsh-llm': '0.1.0-rc.8 || 0.1.3-alpha.1',
      '@deepseek-ai/dsh-system-prompt': '0.1.0-rc.8 || 0.1.3-alpha.1',
      '@deepseek-ai/dsh-tools': '0.1.0-rc.8 || 0.1.3-alpha.1',
    })
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
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
})
