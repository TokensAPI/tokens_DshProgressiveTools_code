/**
 * 宿主自己声明的 Cordis 总线事件名。
 *
 * `ctx.on` 接受任意字符串:名字被上游改掉时插件加载不报错、peer 门禁拦不到、
 * `tsc` 也看不见 —— 订阅就这么静默失效(`agent/session-start` 在 DSH 0.2 被
 * 删除就是一例)。会话事件有 `KNOWN_SESSION_EVENT_TYPES` 可查,总线事件没有,
 * 所以这里扫宿主每个 `@deepseek-ai` 包 `lib/types` 下的 `.d.ts`,找形如
 * `'<命名空间>/<名字>'(` 的监听器签名,和插件的订阅求差集(做法照搬
 * dsh-connect 的 `scripts/host-bus-events.mjs`)。
 *
 * 口径(T0047 A″):只拿插件**真正订阅的那几个名字**去查在不在,不断言宿主
 * 词表的大小或全貌 —— 宿主新增事件一律算兼容。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** `'<ns>/<name>'(` 形式的监听器签名。 */
const LISTENER = /'([a-z][a-z\d-]*(?:\/[a-z][a-z\d-]*)+)'\s*\(/gi

function collectDeclarations(dir, found, depth = 0) {
  if (depth > 6) return found
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) collectDeclarations(path, found, depth + 1)
    else if (entry.name.endsWith('.d.ts')) found.push(path)
  }
  return found
}

/**
 * 宿主声明过的总线事件名。
 * @param {string} root - 宿主根目录(`dsh-plugin-desktop`)。
 * @returns {Set<string>}
 */
export function hostBusEvents(root) {
  const scope = join(root, 'node_modules', '@deepseek-ai')
  const names = new Set()
  let packages
  try {
    packages = readdirSync(scope, { withFileTypes: true })
  } catch {
    return names
  }
  for (const entry of packages) {
    const types = join(scope, entry.name, 'lib', 'types')
    try {
      if (!statSync(types).isDirectory()) continue
    } catch {
      continue
    }
    for (const file of collectDeclarations(types, [])) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(LISTENER)) names.add(match[1])
    }
  }
  return names
}
