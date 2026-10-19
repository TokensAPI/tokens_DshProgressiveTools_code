/**
 * The host names and shapes that differ between DSH 0.1 and DSH 0.2.
 *
 * One published build serves both runtimes, so every such difference is
 * resolved here instead of being spelled out at the call sites. Each entry
 * records which runtime uses which name, so the next host upgrade has one
 * place to revisit.
 */

/**
 * Lossless JSON, as the host requires for a tool's private presentation `meta`.
 *
 * 0.1 re-exported this type from `@deepseek-ai/dsh-tools`; 0.2 moved it to
 * `@deepseek-ai/dsh-util-values` and dropped the re-export. Both runtimes
 * define the same structural type, which is what the host checks, so the
 * plugin keeps its own copy instead of importing from a moving target.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | {
  [key: string]: JsonValue
}

/**
 * A settled `run_code` sub-dispatch in the session log, logged as
 * `tool/code-dispatch` on 0.1 and `tool/ptc-dispatch` on 0.2. Replay reads
 * both, so discovery performed inside `run_code` survives a restart on either
 * runtime. The sub-call ids in those payloads also changed (`<parent>:code:<n>`
 * to `<parent>:ptc:<n>`), which replay does not depend on.
 */
export function isNestedDispatchEvent(type: unknown): boolean {
  return type === 'tool/code-dispatch' || type === 'tool/ptc-dispatch'
}

/**
 * The fields a settled sub-dispatch logs on both runtimes. 0.2 adds an
 * optional structured `error`, which replay does not read.
 */
export interface NestedDispatchData {
  readonly name: string
  readonly arguments: unknown
  readonly isError: boolean
  readonly content: unknown
}

/** One settled tool result from the session log, in the fields replay reads. */
export interface LoggedToolResult {
  readonly callId: string
  readonly isError: boolean
  /** The tool's own result blocks, without either runtime's envelope. */
  readonly content: unknown
}

/**
 * Read a logged `tool/result` message under either runtime's envelope.
 *
 * Every 0.1 release logged a user-role message whose single `tool-result`
 * content block carried `toolCallId`, `isError` and the nested result blocks.
 * 0.2 removed the wrapper block: the message has role `tool`, the result blocks
 * sit directly on `content`, and `isError` is a field of the message. Replay
 * reads both, because a session persisted by a 0.1 runtime stays readable and
 * resume on 0.2 must not silently restore nothing.
 * @param message - the logged message, from a log this plugin did not write.
 * @returns the result's identity and blocks, or undefined when the message is
 * not a tool result.
 */
export function loggedToolResultOf(message: unknown): LoggedToolResult | undefined {
  if (!isRecord(message) || !isRecord(message.source) || typeof message.source.callId !== 'string') return undefined
  const callId = message.source.callId
  if (!Array.isArray(message.content)) return undefined
  const first: unknown = message.content[0]
  if (isRecord(first) && first.type === 'tool-result') {
    return { callId, isError: first.isError === true, content: first.content }
  }
  return { callId, isError: message.isError === true, content: message.content }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
