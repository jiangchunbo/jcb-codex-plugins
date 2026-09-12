# Routing task comparison — 2026-09-11

Historical matrix: the WS/PAC correction and connection reuse are now implemented. See
[the 2026-09-12 verification](ROUTING-FIXES.md) for current results. The original failures below
are retained as evidence of the defect.

The retained comparison contains **95 main runs and 12 configuration-confirmation runs**.
These are real Chromium interactions with synthetic local pages and connection faults, not
public-site performance or model benchmarks. Runtime: Playwright 1.63.0 / Chromium 153.0.8010.12.
Earlier smoke runs are excluded from the reported matrix.

## Conclusions

- Keep delayed competition **off by default**, retain the 250 ms experimental head start.
  It helps a slow/unavailable initial route; this sample does not justify changing the threshold.
- Normal-network task latency is similar across configurations, but the HTTP relay creates many
  more origin connections than the native baseline. Connection reuse deserves optimization.
- A full-browser WebSocket defect remains unresolved: plain WS over Chromium CONNECT is classified
  as HTTPS. With only an HTTP proxy configured, direct failure can break WS after a POST has already
  succeeded. The earlier raw Upgrade test did not cover this browser transport path.
- Do not publish a claim of complete WebSocket routing support, retry the whole failed workflow,
  or synthesize missing HTTPS proxy settings. Fix protocol identification before broad rollout.
- No model default, reasoning effort, browser version, installed cache, or published plugin changed.

## Method

Each fresh context executes one fixed journey: navigate; query an API and assert 42; wait for 12
parallel resources; fill/review/confirm a form and assert one server-side POST; exchange a WebSocket
message; reload and verify Cookie/localStorage persistence without resubmitting. Timing ends after
state verification; reload's remaining resources are not a separate completion requirement.

The main matrix uses only HTTP_PROXY, a valid supported configuration. Its six scenarios are no
added delay, 450 ms direct delay, 450 ms proxy delay, direct refusal, a formerly preferred proxy
refusing connection, and direct setup delayed beyond the runtime's two-second deadline.
The warm proxy case seeds three historical samples per route; all other caches start empty.
Each scenario/configuration is repeated five times, serially, rotating configuration order.

`direct` uses the same relay and fault injector with direct-only policy. `auto` enables ordinary
routing/probes; `race` additionally enables delayed competition. The zero-delay `native` baseline
uses no relay and runs only in the normal scenario. No proxy credentials are required. Faults are
injected before actual local TCP/CONNECT, so these are controlled connection delays, not measured
Internet latency. HTTPS page/WSS coverage is outside this HTTP/WS matrix; existing TLS tests remain
separate. Non-fixture relay destinations are blocked, and Chromium's resolver is restricted to local
addresses. One browser process is reused; each context/cache is fresh. Launch, model thinking,
MCP transport, and cleanup are excluded from task timing.

Success percentiles exclude failed tasks; failure counts remain visible. With only five samples,
P95 is the observed maximum, not a reliable population-tail estimate. Connection attempts include
probes, cancellations, and any browser retries; origin connections count actual accepted sockets.
Counts are collected after cleanup. Compare counts within a scenario, since stopping after state
verification can cancel remaining reload resources in delayed scenarios.

## Main matrix: HTTP proxy only

| Scenario | Mode | Complete tasks | Successful P50 ms | Successful P95 ms | All-attempt P95 ms | Mean attempts | Mean origin connections |
| --- | --- | --- | --- | --- | --- | --- | --- |
| normal | direct | 5/5 | 207 | 223 | 223 | 30.2 | 30.2 |
| normal | auto | 5/5 | 203 | 210 | 210 | 32.2 | 32.2 |
| normal | race | 5/5 | 202 | 214 | 214 | 32.2 | 32.2 |
| normal | native | 5/5 | 199 | 203 | 203 | — | 7 |
| direct-slow | direct | 5/5 | 4062 | 4104 | 4104 | 24 | 18 |
| direct-slow | auto | 5/5 | 4060 | 4108 | 4108 | 26 | 20 |
| direct-slow | race | 5/5 | 920 | 927 | 927 | 27 | 20 |
| proxy-slow | direct | 5/5 | 223 | 239 | 239 | 24 | 18 |
| proxy-slow | auto | 5/5 | 230 | 232 | 232 | 26 | 19 |
| proxy-slow | race | 5/5 | 229 | 238 | 238 | 26 | 19 |
| direct-refused | direct | 0/5 | — | — | 18 | 1 | 0 |
| direct-refused | auto | 0/5 | — | — | 222 | 20 | 17 |
| direct-refused | race | 0/5 | — | — | 222 | 20 | 17 |
| proxy-refused-warm | direct | 5/5 | 230 | 234 | 234 | 24 | 18 |
| proxy-refused-warm | auto | 5/5 | 242 | 246 | 246 | 25 | 18 |
| proxy-refused-warm | race | 5/5 | 238 | 251 | 251 | 25 | 18 |
| direct-timeout | direct | 0/5 | — | — | 2009 | 1 | 0 |
| direct-timeout | auto | 0/5 | — | — | 4204 | 20 | 17 |
| direct-timeout | race | 0/5 | — | — | 2448 | 20 | 17 |

Main result: **65/95 complete tasks**. Ten direct-only tasks fail at navigation as expected under
direct faults. Twenty automatic/racing tasks fail specifically at WebSocket after their POST has
succeeded; these are product failures, not counted as successful recovery. There were **85 POSTs
and zero duplicate submissions**. Normal-case resource counts are 24 in every mode, making the
native 7 versus auto/race 32.2 mean origin connections a like-for-like workload observation.

For the direct-timeout scenario, navigation alone recovered in approximately 2023 ms with auto
versus 276 ms with competition. Those HTTP-only tasks still failed at the later WebSocket step:
fast navigation is not complete task success.

## Confirmation: both HTTP and HTTPS proxies configured

Repeat only the direct-refused/direct-timeout scenarios, three times per automatic mode, with the
same local proxy explicitly configured for both schemes. This does not change the HTTP-only result
or infer an absent user configuration. All 12 complete journeys succeed, confirming the role of
proxy scheme selection. TLS probing of a plain WS CONNECT endpoint is still semantically wrong;
this confirmation is not a fix for protocol classification.

| Scenario | Mode | Complete tasks | Successful P50 ms | Successful P95 ms | Mean attempts | Mean probes |
| --- | --- | --- | --- | --- | --- | --- |
| direct-refused | auto | 3/3 | 264 | 288 | 30 | 4 |
| direct-refused | race | 3/3 | 255 | 260 | 30 | 4 |
| direct-timeout | auto | 3/3 | 4243 | 4252 | 30 | 4 |
| direct-timeout | race | 3/3 | 742 | 744 | 29 | 3 |

## Reproduce

```bash
node plugins/playwright-fast/evals/benchmark-routing-tasks.js --repetitions=5 \
  --output=plugins/playwright-fast/evals/routing-task-results.json
node plugins/playwright-fast/evals/benchmark-routing-tasks.js --repetitions=3 \
  --proxy-scope=both --scenarios=direct-refused,direct-timeout --modes=auto,race --enforce \
  --output=plugins/playwright-fast/evals/routing-task-both-proxies.json
node --test plugins/playwright-fast/evals/evals.test.js
```

Without `--enforce`, the runner may exit successfully after reproducing the documented known
failures; inspect `ok` and success counts. `--enforce` makes any automatic/racing task failure fatal.
Duplicate POSTs and unexpected failures are always fatal. No source runtime flags, system proxy,
installed plugin cache, or model API configuration are changed.

Raw records: [main matrix](routing-task-results.json),
[configuration confirmation](routing-task-both-proxies.json).
The next implementation priorities are accurate WebSocket/CONNECT protocol handling, then HTTP
connection reuse. Broader natural-network evidence is needed before enabling competition by default.

Validation: all 13 evaluation unit tests passed, including exclusion of failed tasks from success
latency percentiles; skill validation and `git diff --check` passed. This does not erase the
WebSocket failures recorded in the browser matrix.
