# WebSocket routing and HTTP pool verification — 2026-09-12

Both implementation priorities from the previous task matrix are now addressed in repository source.
Publication and installed-cache refresh remain separate; previous model-evaluation changes are intact.

## Changes

Chromium now receives an inline PAC configuration. It directs plain WS to a separate loopback
listener and HTTPS/WSS to the main listener, preserving the scheme before CONNECT delivery. The
listeners share routing policy, cache, and context pins. WS inherits HTTP proxy settings, WSS inherits
HTTPS settings, and neither invents a missing proxy. Plain WS no longer triggers target TLS probes.
No application TLS is decrypted and no page WebSocket API is replaced.

HTTP forwarding now reuses context-owned, origin-and-route-specific connections. Pools allow six
active/six idle sockets, 30-second idle expiry, and at most 128 cached pools. Active requests are not
subject to idle expiry. A pool whose connecting socket falls back to another route is retired;
queued work finishes without accepting new work into the incorrectly labelled pool. Failed business
requests are not replayed, including POST. Closing/resetting the runtime disposes its pools.

## Validation

- All **58 regression tests passed**, including actual Chromium WS/WSS, distinct HTTP/HTTPS proxy
  configurations, HTTP-only/HTTPS-only settings, binary frames, WebSocket subprotocols, cookies,
  localStorage, one rejected upgrade, and no TLS probe for plain WS.
- Pool tests confirm socket reuse, route/context isolation, one POST after response loss, and 12
  concurrently queued POSTs submitted exactly once through pre-delivery fallback.
- The PAC-only targeted matrix completed **12/12** previously failing HTTP-only automatic/racing
  journeys. Records: [routing-ws-fixed-results.json](routing-ws-fixed-results.json).
- Final full matrix: **85/95** complete journeys. All **60/60 automatic/racing** journeys passed.
  The ten failures are the expected direct-only navigation failures under direct refusal/timeout.
  Native and remaining direct-only cases passed. There were **zero duplicate POST tasks**.
- Skill validation and `git diff --check` passed. Warm source MCP benchmark: 30 ultra calls,
  wall P50 **4.2 ms**, P95 **8.2 ms** (the enforced P95 ceiling remains 250 ms).

A first pool implementation produced one automatic/racing resource timeout. That failed trial is
retained in [routing-pac-pool-initial.json](routing-pac-pool-initial.json). It is not merged into the
final matrix: the pool retirement/free-event handling was corrected, targeted queue tests were added,
and the full matrix was rerun. This makes the final result reproducible without hiding the discovery.

## Final task matrix

The fixed tasks and synthetic network conditions are the same as the previous matrix. Main rows
still configure **only HTTP_PROXY**, so they exercise the original WebSocket failure configuration.
Each row has five repetitions; reported P95 is the observed maximum, not a reliable population-tail
estimate. Failed-task durations are excluded from successful-task percentiles. The native baseline
has no relay; the controlled `direct` mode retains the relay with direct-only routing.

The updated harness creates a fresh browser for each task because PAC is a launch-level option,
and excludes launch/cleanup from task time. Previous runs reused one browser with per-context
manual proxies, so historical timing comparisons are indicative, not a strict paired experiment.
These remain local HTTP/WS browser tasks with injected connection delay, not Internet benchmarks or
model-speed measurements. TLS/WSS coverage comes from the dedicated regression tests above.

| Scenario | Mode | Complete | Successful P50 ms | Successful P95 ms | Mean origin connections |
| --- | --- | --- | --- | --- | --- |
| normal | direct | 5/5 | 214 | 241 | 7 |
| normal | auto | 5/5 | 211 | 229 | 9 |
| normal | race | 5/5 | 218 | 223 | 9 |
| normal | native | 5/5 | 210 | 226 | 7 |
| direct-slow | direct | 5/5 | 1877 | 3851 | 7 |
| direct-slow | auto | 5/5 | 1896 | 4137 | 9 |
| direct-slow | race | 5/5 | 489 | 528 | 10 |
| proxy-slow | direct | 5/5 | 225 | 234 | 7 |
| proxy-slow | auto | 5/5 | 229 | 232 | 8 |
| proxy-slow | race | 5/5 | 227 | 235 | 8 |
| direct-refused | direct | 0/5 | — | — | 0 |
| direct-refused | auto | 5/5 | 240 | 251 | 9 |
| direct-refused | race | 5/5 | 238 | 245 | 9 |
| proxy-refused-warm | direct | 5/5 | 234 | 237 | 7 |
| proxy-refused-warm | auto | 5/5 | 243 | 246 | 7 |
| proxy-refused-warm | race | 5/5 | 243 | 244 | 7 |
| direct-timeout | direct | 0/5 | — | — | 0 |
| direct-timeout | auto | 5/5 | 2232 | 2234 | 9 |
| direct-timeout | race | 5/5 | 483 | 486 | 9 |

Normal automatic/racing tasks now use **9** origin connections, including two probes, versus **7**
for native direct. The previous relay averaged **32.2** in that workload. Connection competition
still stays **off by default**: it helps the artificial slow/timeout conditions, but normal timing
is similar and this small local sample does not justify a global default change or a new delay.

## Reproduce

```bash
node --test plugins/playwright-fast/tests/*.test.js plugins/playwright-fast/evals/evals.test.js
node plugins/playwright-fast/evals/benchmark-routing-tasks.js --repetitions=5 --enforce \
  --output=plugins/playwright-fast/evals/routing-pac-pool-results.json
node plugins/playwright-fast/evals/benchmark-hot-run.js --iterations=30 --enforce
```

`--enforce` now treats all automatic/racing failures as fatal; only deliberate direct-only
navigation failures are accepted by the runner. Raw final records:
[routing-pac-pool-results.json](routing-pac-pool-results.json).

The protocol mechanism is documented by Chromium in
[proxy.md](https://github.com/chromium/chromium/blob/main/net/docs/proxy.md).
Operational details and limits are in [routing.md](../skills/playwright/references/routing.md).
