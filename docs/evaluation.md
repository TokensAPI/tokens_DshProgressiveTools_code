# Native discovery evaluation

Date: 2026-09-08. Candidate: 0.2.0. No production business tools were executed.

## Method

`scripts/evaluate.mjs` runs the same synthetic catalog of 55 tools under full
loading, explicit stable-proxy, and native discovery. Four Chinese tasks cover
status lookup with a destructive distractor, dependent customer/invoice lookup,
an explicitly named inspection tool, and a chart attachment result. Each mode
has two repetitions per task (8 trials). Temperature is zero; each trial has a
fresh context and at most 9 model requests. Task success requires the expected
tool sequence and exact arguments, no unrelated operations, and a terminal
non-empty response. It is not a general semantic grading of the answer.

Live requests used the configured production text model and its existing endpoint.
Only synthetic prompts, tool schemas and mock outputs were sent. Tool execution
used the real registry/prompt services in a small evaluation loop, not the full
desktop UI. Token counts below are API-reported usage, not character estimates.
Native trials were rerun after the final exact-name loading correction; the
unchanged full/proxy baselines were retained. An earlier interrupted pilot is
excluded. Different run times and uncontrolled provider caches limit comparison.

## Results

Totals for 8 trials per mode:

| Measure | Full | Stable proxy | Native |
| --- | ---: | ---: | ---: |
| Successful synthetic workflows | 8/8 | 8/8 | 8/8 |
| Workflows preserving native result identity/metadata | 8/8 | 6/8 | 8/8 |
| Input tokens, including cache hits | 93,334 | 45,129 | 34,650 |
| Output tokens | 1,034 | 2,584 | 2,115 |
| Cached input tokens | 84,736 | 29,184 | 16,640 |
| Uncached input tokens | 8,598 | 15,945 | 18,010 |
| Model requests | 18 | 26 | 26 |
| Tool calls, including discovery | 10 | 25 | 23 |
| Tool execution errors | 0 | 0 | 0 |

Native reduced total input tokens by 62.9% versus full loading and 23.2%
versus stable proxy. Input plus output tokens fell 61.0% versus full loading.
All modes completed these simple mock workflows. This does not demonstrate
increased general model capability or statistically establish non-inferiority.

The two proxy contract failures were the chart trials: image blocks survived,
but the outer call identity and target presentation metadata did not. The check
asserts protocol preservation, not actual rendered pixels or file delivery.
The mock image reference is not backed by real image bytes.

Full loading had far more cache hits; native had more uncached input. Therefore
these results do not establish lower billing cost. Discovery also added model
round trips. Wall times are not used as performance evidence because the runner
includes 1.5 seconds of pacing per request and backoff on HTTP 429 responses.

## Real session schema audit

A local exported session with 53 tool definitions was audited without executing
its tools or sending its contents to a model. Native first-request projection
contained 10 tools. Schema-only character/4 estimates changed from 10,876 to
2,097 (80.7% reduction). This excludes system instructions, directory text,
history, subsequent discovery, tokenizer differences and cache pricing; it is
not an 80.7% claim about total usage or cost.

## Regression and runtime checks

- 58 tests passed, including native AgentLoop request projection, exact-name
  loading, paginated recovery, localized group aliases, no implicit sibling
  activation, scope restrictions, post-policy rejection, native content/meta,
  deferred contexts, conclusion, cancellation, errors, reconnect, session
  isolation, snapshot/nested-history restoration and unload.
- Type checking, lint, compilation and package lint passed on the development
  runtime 0.1.0-rc.8.
- Compiled plugin smoke tests passed against the desktop 0.1.3-alpha.1 dependency
  graph, including snapshot history, first assembly, loading, parameter validation,
  image content and original presentation metadata.
- Complete browser/desktop rendering, real approval dialogs, full code-runtime
  orchestration, long-context saturation and arbitrary plugin workflows have not
  been exhaustively exercised. No provider-native deferred-reference integration
  is implemented in this candidate.

## Reproduce

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm run test:runtime
pnpm run eval:offline
# Set EVAL_BASE_URL, EVAL_API_KEY, EVAL_MODEL in the environment, then:
pnpm run eval:live
```

`EVAL_REPEATS` controls repetition (default 2). `--native-only` reruns just native.
Raw synthetic trial results are written under ignored `.validation/`; credentials
are read only from the environment and never included in reports. To exercise
a different installed runtime with Node 22.19+ / 24, set `DSH_TEST_RUNTIME` to
the host directory containing `node_modules`. `DSH_TEST_PLUGIN` can point to an
extracted package's `lib/index.js` to test the packed artifact.

Keep native discovery as a reliability-oriented option for sparse tool usage.
Before broad rollout, expand paired tasks across models, languages and long
sessions, control cache conditions, and measure actual prices and latency.
