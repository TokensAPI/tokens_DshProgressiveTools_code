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
