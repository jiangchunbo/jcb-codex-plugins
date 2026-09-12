# Playwright Fast Agent Evaluations

This suite measures whether Codex models can use Playwright Fast naturally from a browser task
written in ordinary language. It complements the deterministic contract/runtime tests; it does not
replace them.

The speed-focused methodology and findings are in [SPEED.md](SPEED.md).

The latest checked-in findings and three-model matrix are in [RESULTS.md](RESULTS.md).

## What is measured

- task correctness, verified by fixture state and requested answer values
- whether the first `run` contract is valid
- Playwright Fast calls, failed calls, correction calls, and unrelated tool calls
- unnecessary `status` and `reset` usage
- end-to-end latency and Playwright Fast's own reported runtime
- repeated friction across models or repeated attempts

The case catalog contains 14 deterministic fixture tasks and two opt-in local-project tasks. The
real tasks use `/home/jcb/projects-tq/web-zwpg-2c-admin` and
`/home/jcb/projects-tq/web-zwpg-2c` without real credentials or writes to either repository.

## Run

Start with the bounded smoke suite:

```bash
node plugins/playwright-fast/evals/run-agent-evals.js --mode smoke
```

Run the agreed layered suite (up to 90 model turns):

```bash
node plugins/playwright-fast/evals/run-agent-evals.js --mode layered --concurrency 3
```

Run the conditional-delegation matrix (three decisions across three parent models):

```bash
node plugins/playwright-fast/evals/run-delegation-evals.js --concurrency 3
```

This matrix scores actual `spawn_agent` calls from each isolated Codex session, their model,
reasoning effort, fork mode, assignment contents, parent execution lane, and fixture oracle. It does
not grade copied Skill text. Delegation runs keep their otherwise isolated sessions long enough to
read the complete rollout because the public `codex exec --json` event stream can omit collaboration
events; the generated sessions and result records are ignored build artifacts.

Useful narrower forms:

```bash
node plugins/playwright-fast/evals/run-agent-evals.js --mode first-pass --skip-real
node plugins/playwright-fast/evals/run-agent-evals.js --case element-control --models gpt-5.6-luna
node plugins/playwright-fast/evals/run-agent-evals.js --mode layered --dry-run
```

Each run writes raw scored records, `summary.json`, and `report.md` under the ignored `results/`
directory. Rebuild a report without calling a model:

```bash
node plugins/playwright-fast/evals/score-agent-evals.js plugins/playwright-fast/evals/results/<run>
```

Overlay targeted post-fix reruns onto a first pass without counting both versions:

```bash
node plugins/playwright-fast/evals/score-agent-evals.js \
  plugins/playwright-fast/evals/results/<first-pass> \
  plugins/playwright-fast/evals/results/<post-fix> \
  --output plugins/playwright-fast/evals/results/<final-matrix>
```

The runner disables the unrelated local `idea` and `lanhu` MCP servers for its child Codex tasks.
It uses the current app's non-interactive `never` approval behavior with an unrestricted sandbox so
browser calls are not rejected before reaching the plugin. Evaluation prompts are fixed local-page
tasks and explicitly prohibit shell and file operations. The installed Playwright Fast plugin stays
enabled so the evaluation sees the same Skill and tool schema as an ordinary task.

## Hot runtime benchmark

```bash
node plugins/playwright-fast/evals/benchmark-hot-run.js --iterations=30 --enforce
```

The benchmark warms one MCP process, then measures compact read/assertion contracts. The enforced
targets are wall-clock P50 at or below 100 ms and P95 at or below 250 ms.

## Interpreting failures

A failed case is not automatically a plugin defect. Treat a friction signature as a plugin
candidate only when it appears in at least two models or at least twice for one model. Environment
startup and real-page availability failures are reported separately. Prefer compatibility inside
the schema/runtime over retries, force clicks, extra tools, or additional user steps.

## Model effort and explicit skill evaluation

Use `model@effort` entries (an omitted effort is pinned to medium). Cases can be comma-separated.
For reproducible skill evaluation include the source skill explicitly:

```bash
node plugins/playwright-fast/evals/run-agent-evals.js --mode first-pass --skip-real \
  --models gpt-5.5@low,gpt-5.6-luna@low,gpt-5.6-terra@medium \
  --case basic-form,frame-popup,procurement-workflow --inline-skill --concurrency 1
```

The runner saves event receipt timestamps and a manifest; inline runs also save the skill text.
Token rate is end-to-end effective output token/s, not decoder speed; non-tool time is not isolated
thinking time. Keep the model lane serial for latency comparisons. Concurrent browser work can
otherwise compete for resources or request capacity.

Use `--service-tier priority` for a separately labelled Fast-tier experiment; the default is pinned
to `default`. The CLI records the requested tier, not a server-confirmed tier. Do not overlay
results across tiers or skill snapshots into a single model ranking.

## Adaptive routing validation

Run the deterministic local suite against repository source (no installation refresh needed):

```bash
node --test plugins/playwright-fast/tests/*.test.js plugins/playwright-fast/evals/evals.test.js
node plugins/playwright-fast/evals/benchmark-hot-run.js --iterations=30 --enforce
```

Routing tests use local HTTP/TLS origins and controllable HTTP/HTTPS CONNECT proxies. They cover
environment precedence, private DNS/NO_PROXY, disabled/unsupported proxies, cold selection,
failure recovery and hysteresis, context pinning, process-sharded cache/epoch isolation, corrupt
and expired cache, global probe leases, cancellation, opaque tunnels, WebSocket streams, and
non-replayed POSTs. A real Chromium case checks cookie/localStorage preservation through the relay.
OpenSSL is needed to generate temporary test-only certificates; tests trust those certificates
explicitly without weakening production verification.

The hot routing assertion measures policy overhead with 1000 targets / 16000 records and a stubbed
connector, excluding socket IO. It enforces P95 below 5 ms. The separate MCP benchmark measures
actual warm browser read/assertion calls; it is not a network benchmark.

For an explicitly opted-in, small live check using the current inherited proxy environment:

```bash
node plugins/playwright-fast/evals/benchmark-routing.js --live
```

This visits only example.com and www.wikipedia.org as intended page targets. Chromium can also
make background requests, which are subject to the same routing rules. The script reports page
completion separately from its bounded wait for background diagnostics. It does not change proxy
configuration, clear prior learned data, call a model API, or alter a speed tier.

Observed on 2026-09-11 (source MCP, normal inherited environment; live run at 09:50:53 UTC):

The final local regression passed all 49 tests (including 20 routing tests); skill validation and
`git diff --check` also passed.

| Check | Result |
| --- | --- |
| Cached routing decision, 1000 targets / 16000 records | P95 1.221 ms; socket IO excluded |
| Warm MCP, 30 ultra calls | P50 3.6 ms, P95 6.2 ms; cold start 647.3 ms |
| example.com | Success, title `Example Domain`, direct; browser 1138 ms |
| www.wikipedia.org | Success, title `Wikipedia`, inherited proxy; browser 1381 ms |
| Runtime connection fallback count | 0 after first page, 2 after second; includes Chromium background traffic |

At that snapshot example.com had one successful probe on each route (direct 326 ms, proxy 532 ms).
Wikipedia had one failed direct probe (3000 ms scoring penalty) and one successful proxy probe
(514 ms). These are connection-quality observations with insufficient samples for a
performance-driven route switch, not a controlled before/after speedup experiment. Deterministic
tests verify the exact fallback boundary and no POST replay; the live aggregate cannot assign
every fallback to an individual page. Local per-target statistics remain in the machine cache,
not in the repository. See [routing behavior and limitations](../skills/playwright/references/routing.md).

### Phase-two controlled comparison

The same test command now covers 53 tests, including 24 routing tests. New cases exercise delayed
competition, fast-primary suppression of speculation, simultaneous first opens, both-route
failures, shutdown cancellation, actual TCP/CONNECT phase metrics, bounded diagnostic retention,
and once-only POST submission. No external website is required for these comparisons.

Observed on 2026-09-11: with controlled connection delays of 900 ms direct and 20 ms alternate,
the first POST took 905.6 ms with competition off and 273.5 ms with it on (250 ms head start).
The winner remained pinned for the next POST; the cancelled loser added no route-failure sample.
This is a synthetic connection-delay experiment, not a prediction of public-site speedup.
The warm MCP benchmark remained within budget: 30 ultra calls, P50 2.9 ms and P95 5.3 ms.
The routing-policy assertion at 1000 targets / 16000 records measured P95 1.455 ms.

Keep `PLAYWRIGHT_FAST_CONNECT_RACE` off by default pending broader natural-network evidence.
For an optional live run, prefix the existing live command with
`PLAYWRIGHT_FAST_CONNECT_RACE=on`; its JSON output includes phase timings and competition counters.
Inherited proxy discovery, local cache isolation, and model speed settings are unchanged.

A small live check with competition enabled at 2026-09-11 10:12:23 UTC also completed both pages:
example.com took 1175 ms of browser runtime and Wikipedia 1122 ms. The runtime reported two
alternate attempts/wins and two cancelled contenders in total, including background Chromium
requests. No cancelled contender became a route failure. Top-level navigation timings were
806.8 ms and 1118.8 ms respectively; these exclude cold launch and post-navigation reads.
This used existing learned data, so it is observational validation, not a controlled comparison
with the earlier run. Measured proxy CONNECT times were small while target TLS probes took hundreds
of milliseconds: CONNECT completion alone must not be interpreted as complete HTTPS readiness.

### Phase-three task comparison

See [ROUTING-TASKS.md](ROUTING-TASKS.md) for the retained 95-run main matrix and 12-run
configuration confirmation, exact commands, raw records, connection counts, and limitations.
It keeps competition off by default and identifies two priorities: Chromium plain-WS CONNECT
classification and HTTP connection reuse. The HTTP-only main matrix has real WebSocket failures;
do not read successful completion of the measurement script as all tasks passing.

### WebSocket correction and connection reuse

The source now uses Chromium PAC to select a plain-WS listener before CONNECT, and reuses HTTP
connections in context-owned pools. See [ROUTING-FIXES.md](ROUTING-FIXES.md) for the current
58-test regression result, the 95-run final matrix, retained initial failure, and commands.
All 60 automatic/racing tasks passed; ten deliberate direct-only faults still fail as expected.
The current task runner launches a fresh browser per task for its PAC configuration and treats
every automatic/racing failure as fatal under `--enforce`. Earlier matrices remain historical.
