# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and releases follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [Tokens 0.2.6] - 2026-10-19

### Fixed

- **Resume reads a tool result that any supported runtime logged.** 0.1.0 logged
  a tool result as a user-role message wrapping the blocks in one `tool-result`
  content block that carried `toolCallId` and `isError`. From 0.1.5 that wrapper
  is gone: the message has role `tool`, the result blocks sit directly on
  `content`, and `isError` is a field of the message. Replay only understood the
  0.1.0 envelope, so on both shipping runtimes — 0.1.5-rc.2 in TokensCowork 0.5
  and 0.2.0-rc.2 in 0.6 — a resumed session restored no discovery from
  top-level search results, and the monotonic guard then denied tools the model
  had already loaded. `loggedToolResultOf` in `src/host.ts` reads either
  envelope, so an older persisted session stays readable too.

### Changed

- **The development baseline is the runtime the current product ships.** The DSH
  development dependencies move from 0.1.0-rc.8, which neither product line
  runs, to 0.2.0-rc.2 (TokensCowork 0.6), and the test fixtures move to that
  runtime's real shapes: `ToolCallId` for the call-id constructor,
  `Session.snapshotEvents()` for history, `tool/ptc-dispatch` for the
  sub-dispatch log, `kind: 'user'` for a producer-supplied context source (the
  source vocabulary has no catch-all producer kind), an awaited
  `agentLoop.create()`, and the `sessionProjections` service the loop now
  injects. Checking a runtime nobody runs is how the 0.2.5 defects reached
  users, and this is also what surfaced the envelope change above.
- **The checks run on both product lines.** `pnpm run check:dsh-0.1` repins the
  DSH development dependencies to 0.1.5-rc.2 and runs the typecheck, tests and
  build again, restoring the manifest and lockfile afterwards; the `Checks`
  workflow runs it as its own job. One published version serves both runtimes,
  so a change that only holds on one of them now fails in CI.
- `tests/host-contract.spec.ts` locks each renamed boundary from both sides: the
  sub-dispatch log replays under either name and not under an unknown one, the
  name the installed runtime declares is one the plugin accepts, both tool-result
  envelopes restore discovery, a legacy `events` array is still read, and eager
  initialization happens on the announcement the installed runtime emits.
  Narrowing `src/host.ts` back to a single spelling fails these cases.

## [Tokens 0.2.5] - 2026-10-19

### Fixed

- **Loads on the DSH 0.2 runtime.** From 0.2 the host decides at startup whether
  a plugin may load by checking every `@deepseek-ai/dsh*` entry in
  `peerDependencies` against the running version, resolved with prereleases
  included. The published 0.2.4 pinned two exact 0.1 versions, so installing it
  on a 0.2 host disabled it outright, with the reason only on the desktop's
  standard error output. The five DSH peers and `dsh.engine` now declare
  `>=0.1.0-rc.8 <0.3.0-0`, which the host's own gate accepts on `0.1.0-rc.8`,
  `0.1.5-rc.2` and `0.2.0-rc.2`; `0.3` stays out because it has not been
  checked. A caret or tilde range would not work here: semver adds a
  `<0.2.0-0` bound to `^0.1.x`, which a `0.2.0-rc.2` host rejects.
  `@deepseek-ai/cordis` adds the `4.0.4` the 0.2 runtime ships.
- **Resume no longer forgets tools discovered inside `run_code`.** The host
  renamed the settled sub-dispatch log from `tool/code-dispatch` to
  `tool/ptc-dispatch` in 0.1.5, so replay saw none of those entries on any
  runtime newer than 0.1.0 and the monotonic guard then denied tools the model
  had already loaded. Replay now reads both names in every mode. The payload
  fields it folds are unchanged; 0.2 only adds an optional structured `error`.
- **Eager per-agent initialization survived the removal of
  `agent/session-start`.** 0.2 deleted that event, which left the catalog to be
  built lazily at the first assembly and, in `dynamic` mode, left the initial
  restriction uninstalled until the first claimed turn. Initialization now
  listens to `agent/created`, the per-agent announcement both runtimes emit for
  every start source; on 0.1 it runs in the same synchronous publication
  sequence the removed event ran in.

### Changed

- `src/host.ts` collects the host names and shapes that differ between the two
  runtimes, so one published build keeps serving both and the next host upgrade
  has a single place to revisit. `JsonValue` is declared there as well: 0.1
  re-exported the type from `@deepseek-ai/dsh-tools` and 0.2 moved it to
  `@deepseek-ai/dsh-util-values` without a re-export.
- `scripts/native-smoke.mjs` reads the names it needs off the host under test
  instead of assuming them, and additionally asserts the host's own
  `evaluatePluginCompatibility` verdict for this manifest when the host ships
  it. `DSH_TEST_RUNTIME=<host> pnpm run test:runtime` therefore checks a real
  runtime end to end, and a further rename fails loudly instead of quietly
  degrading discovery.

## [Tokens 0.2.4] - 2026-10-12

### Added

- `locale/en.json` and `locale/zh.json` carry the display metadata the dsh Plugins page
  reads, exported as `./locale/*.json`. That page ignores the market's `tokenscowork`
  field, so it previously fell back to the full package name and the single-language
  `description`. The package test keeps both sources identical, the two languages
  distinct, and the files in the packed tarball.

## [Tokens 0.2.3] - 2026-09-24

### Added

- `dsh.engine` declares the target DSH runtime range (`0.1.0-rc.8 || 0.1.3-alpha.1`),
  matching the core peer ranges. Upstream does not read this field today, so nothing
  changes at install time; declaring it is what lets a plugin check decide whether
  this plugin and a given runtime are compatible, which previously could not be
  judged at all. A package test pins the field to the `@deepseek-ai/dsh-tools` peer
  range so the two cannot drift apart.

### Changed

- The package contract test no longer pins a literal version string. It checks the
  version is well-formed semver and that the changelog has a section for it, so a
  bump cannot fail the suite for the wrong reason on the way to a release.

## [Tokens 0.2.2] - 2026-09-23

### Changed

- Documentation collected under `docs/`, with the Chinese README as the root default.
- Release automation split into `checks.yml` for branches and pull requests and
  `publish-npm.yml` for `v*` tags. Pushing a tag is the only publish path, and it
  gates on the full check matrix.

### Fixed

- The packing step passed `pnpm pack --ignore-scripts`, which pnpm rejects as an
  unknown option, so a tag release would have failed before publishing anything.
- A registry error while probing for an already published version no longer reads
  as "this version is not published yet"; the release aborts instead.

## [Tokens 0.2.1] - 2026-09-22

### Added

- Bilingual TokensCowork marketplace metadata, so the display name and summary
  render in Simplified Chinese and English.
- A private npm release workflow gated on a `v*` tag. It runs the full check
  suite before packing, validates the release with `scripts/validate-release.mjs`
  (the tag has to match the package version and the remote has to be this
  repository), and refuses to overwrite a version that is already published.

### Changed

- `publishConfig` points at the private registry `https://npm.tokensapi.ai/`
  instead of the public one.

## [Tokens 0.2.0] - 2026-09-08

### Changed

- Default to exact native tool loading instead of proxy execution. Explicit
  stable-proxy and dynamic configurations retain their previous behavior.
- Preserve loaded native definitions and guidance for the session without
  automatic eviction. Existing proxy histories require rediscovery after switching.

### Added

- Paginated discovery and browse, exact-name loading, and a bounded capability directory.
- Native execution contract tests, a compiled-package host-runtime smoke test,
  and synthetic full/proxy/native model evaluations with provider token accounting.
- See `docs/evaluation.md` for measured results and limits; no general model
  capability improvement or cache-cost saving is assumed from schema reduction.

## [Tokens 0.1.4] - 2026-09-08

### Fixed

- Read session history through the `snapshotEvents()` API used by desktop
  0.4.3 while retaining the legacy `events` fallback, preventing first-turn
  failures during progressive state initialization and replay restoration.

## [Tokens 0.1.3] - 2026-09-08

### Fixed

- Removed the legacy `CallId` runtime import so the plugin loads with the
  renamed tool-call identifier exported by the desktop 0.4.3 runtime.
- Declared peer compatibility with both the public DSH `0.1.0-rc.8` packages
  and the DSH `0.1.3-alpha.1` runtime bundled by desktop 0.4.3.

## [Tokens 0.1.2] - 2026-09-07

### Fixed

- `tool_search` now states that the catalog is indexed in English and asks for
  English keywords, so non-English requests are translated before searching
  instead of missing every tool.
- A search that matches nothing now returns the deferred family list and a
  retry instruction instead of an empty array, so an unmatched query is no
  longer read as "the capability does not exist". An empty match set still
  discovers nothing, so dispatch gating is unchanged.
## [Tokens 0.1.1] - 2026-08-29

### Fixed

- Removed the install-time `prepare` lifecycle script so managed plugin
  markets can verify and install the prebuilt package without executing
  package scripts on user machines.

## [Tokens 0.1.0] - 2026-08-28

### Added

- Tokens-owned package and Cordis identities for marketplace distribution.
- A product-tuned stable direct surface for common file, shell, Skill, task,
  interaction, and file-return tools.
- Exact DSH `0.1.0-rc.8` development and peer compatibility, including a
  fully pinned rc.8 test graph.
- Package identity tests and retained upstream MIT attribution.

### Based on

- Upstream `dsh-progressive-tools` 0.3.0 at commit
  `8d516b9933d5b7812ab39c929fd9ee5df66d5221`.

## [0.3.0] - 2026-08-25

Upgrading changes the stable discovery prompt text, so every deployment pays
one context-cache cold start on the first request after the upgrade; the
prefix is byte-stable again from the second request onward.

### Added

- Family-wide discovery: each stable search match lists every member tool name
  of its family (`groupTools`), and the whole family becomes dispatchable from
  that one search, so a plugin's tool surface is no longer truncated to the
  top-ranked slice.
- Stable-proxy `status` action lists every deferred family with member tool
  names, giving the model a catalog-browsing fallback when a search query has
  no lexical overlap.
- `statusGrantsDiscovery` option (default `false`): when enabled, one `status`
  listing makes every cataloged name dispatchable. The default keeps dispatch
  behind a seen schema and the rejection message points to the deterministic
  exact-name recovery search.
- Generic verb prefixes (`get`, `list`, `create`, ...) never merge into
  automatic families, so unrelated plugins sharing a prefix stay separate.
- The built-in image-generation family covers generation task helpers such as
  `get_image_generation_task` and `cancel_image_generation_task`.
- CJK character-bigram tokenization so queries without space-delimited words
  match deferred definitions and family metadata without configured aliases.
- `tool_dispatch` delegates its parallel-scheduling classification to the
  target tool, so concurrency-safe deferred tools keep overlapping execution.
- Documentation: an ecosystem onboarding checklist (`alwaysVisible` for
  high-frequency tools, `skillBindings` for Skill-shipping packages, explicit
  `groups` for unconventional names).

### Changed

- Search results now record per-call discovery increments in the rendered
  text, plus a cumulative `discoveredCount`; the cumulative name list moved to
  presentation metadata, so conversation growth stays bounded and resume
  restores full state from the latest surviving entry.
- The stable discovery prompt clarifies that names mentioned elsewhere in the
  prompt still require discovery, and points to `status` for catalog browsing.
- `max_results` values outside the configured range are clamped instead of
  rejected, matching upstream tool-search semantics.

### Fixed

- The routing guard prepares per-agent state on demand, closing a
  direct-call window before the first assembly or session-start event.
- Discovered-tool state survives registry refreshes such as provider
  reconnects; dispatch validates catalog membership at call time.
- Dispatch failures preserve the real tool's structured error code instead of
  collapsing it into an unstructured message.

## [0.2.0] - 2026-08-25

### Added

- Cache-stable `stable-proxy` mode as the new default.
- Fixed first-request surface with `tool_search`, `tool_dispatch`, and
  configurable common direct tools.
- Exact definition search with BM25-style lexical ranking over nested schema
  text and multilingual family aliases.
- Nested real-tool dispatch through the complete DSH execution pipeline.
- Monotonic routing guard for direct-call and Code Mode bypass prevention.
- Stable Code Mode SDK projection and conservative tool-guidance deferral.
- Real AgentLoop request regression test for first-request and prefix stability.

### Fixed

- First request no longer sends the full tool catalog before progressive state
  takes effect.
- Dynamic-mode search and Skill activation now affect the immediately following
  request instead of lagging one request boundary.
- Request lifecycle documentation now matches the official assembly order.

### Changed

- Search returns exact tool definitions in stable mode instead of activating a
  whole family.
- Agent-scoped tools can be deferred in stable mode.
- `dynamic` is now an explicit compatibility mode.

## [0.1.0] - 2026-08-25

### Added

- Per-agent progressive tool discovery through the official scoped restriction
  API.
- Configurable family rules, multilingual aliases, and automatic fallback
  grouping.
- Token-budget, LRU, family-cap, and turn-TTL retention controls.
- Optional skill-to-family activation bindings.
- Dynamic registry refresh and reversible lifecycle cleanup.
- Resume restoration for top-level and nested discovery calls.
- Bundle manifest, GitHub source-install build path, documentation, tests, and
  continuous integration.

[Unreleased]: https://github.com/TokensAPI/tokens_DshProgressiveTools_code/compare/v0.2.4...HEAD
[Tokens 0.2.4]: https://github.com/TokensAPI/tokens_DshProgressiveTools_code/releases/tag/v0.2.4
[Tokens 0.2.3]: https://github.com/TokensAPI/tokens_DshProgressiveTools_code/releases/tag/v0.2.3
[Tokens 0.2.2]: https://github.com/TokensAPI/tokens_DshProgressiveTools_code/releases/tag/v0.2.2
[Tokens 0.2.1]: https://github.com/TokensAPI/tokens_DshProgressiveTools_code/releases/tag/v0.2.1
[Tokens 0.2.0]: https://github.com/TokensAPI/tokens_DshProgressiveTools_code/releases/tag/v0.2.0
[Tokens 0.1.0]: https://github.com/TokensAPI/tokens_DshProgressiveTools_code/releases/tag/v0.1.0
[0.3.0]: https://github.com/everclear077/dsh-progressive-tools/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/everclear077/dsh-progressive-tools/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/everclear077/dsh-progressive-tools/releases/tag/v0.1.0
