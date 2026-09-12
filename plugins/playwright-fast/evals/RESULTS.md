# Playwright Fast Agent Evaluation Results

The current speed-focused model/effort recommendation and 2026-09-11 measurements are in
[SPEED.md](SPEED.md). The Terra/medium results below are historical 1.1.2 validation.

## 1.1.2 conditional-delegation validation

Evaluation date: 2026-09-10. The final nine-run matrix covered three decision scenarios with Sol,
Terra, and Luna as the parent model. All nine passed: delegation decisions, required execution lane,
Terra/medium configuration, self-contained assignments, and browser fixture results were each 100%.
There were no nested or duplicate delegations.

| Parent model | Runs | Success | Decision | Execution lane | Terra/medium |
|---|---:|---:|---:|---:|---:|
| gpt-5.6-sol | 3 | 100% | 100% | 100% | 100% |
| gpt-5.6-terra | 3 | 100% | 100% | 100% | 100% |
| gpt-5.6-luna | 3 | 100% | 100% | 100% | 100% |

The ordinary three-model smoke matrix initially passed 8/9. Sol stopped after the expected missing
target failure instead of performing the requested single diagnosis; the immediate targeted rerun
passed, producing a 9/9 selected overlay. First-run contract validity remained 100%, and `status`,
`reset`, unrelated-tool calls, plugin crashes, and plugin timeouts remained zero. This single-model,
single-run fluctuation does not meet the threshold for expanding the plugin contract.

The smoke median remains two `run` calls and only one of six ordinary smoke tasks completed in one
call. The earlier full selected matrix likewise completed only 7 of 42 ordinary tasks in one call,
so 1.1.2 has not yet achieved the one-run usability target.

Evaluation date: 2026-09-09. The final matrix uses one result per case and model, overlaying the
targeted post-fix reruns on the 45-run first pass. In total, 59 formal model tasks were executed;
development smoke probes are not counted here.

## Final matrix

| Model | Runs | Task success | Fixture | Real pages | First contract valid | Median run calls | E2E P50/P95 ms | Agent overhead P50/P95 ms | Plugin P50/P95 ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| gpt-5.6-sol | 15 | 100% | 100% | 100% | 100% | 3 | 68,424/170,318 | 67,745/144,002 | 691/26,316 |
| gpt-5.6-terra | 15 | 100% | 100% | 100% | 100% | 2 | 42,747/91,366 | 42,598/61,500 | 811/31,013 |
| gpt-5.6-luna | 15 | 100% | 100% | 100% | 100% | 3 | 46,539/95,781 | 45,947/87,157 | 769/8,624 |

Aggregate task success, fixture success, real-page success, and first-contract validity are all
100%. There were no `status`, explicit `reset`, unrelated-tool, plugin-crash, or plugin-timeout
failures in the selected final matrix.

The final hot 30-run runtime benchmark passed at 4.8 ms P50 and 7.2 ms P95, comfortably below the
100/250 ms targets. Agent overhead is end-to-end time minus reported Playwright runtime; Codex JSONL
does not expose pure model inference wall time, so it is a proxy rather than a direct inference timer.

## What remains

The ordinary-task median is two `run` calls, not the target of one; only 7 of 42 ordinary runs used
one call. This is now the main usability gap. Sol also showed real uni-app latency variance: one
rerun timed out at 180 seconds after encountering a retained application login state, while the
third observation passed in 170 seconds. The plugin itself spent only a small fraction of that
time, so expanding the contract around this single-model fluctuation is not justified.

The remaining repeated intermediate failures are concentrated in locator choice, page-owned
console/page errors on the real applications, and Luna occasionally combining two selector keys or
emitting invalid JavaScript for `evaluate`. Keep these visible in reports, but do not broaden the
plugin interface until the same concrete shape repeats under the agreed threshold.

## Improvements validated in this round

1. Added exact-to-substring fallback for natural label and text targets, while preserving ambiguity
   failures.
2. Made `readValue` return text for non-form value displays and report the fallback.
3. Accepted targetless and timed `readAllText`, target-scoped `evaluate`, and target `title` labels.
4. Handled empty 204/205/304 response bodies without protocol failures.
5. Raised compatible timeout bounds, corrected serial budget estimation, and recognized
   same-document Hash Router navigation.
6. Added one concise `nextAction` after failures and clarified that `reset` is not a startup step.
7. Corrected evaluator attribution, no-data reporting, process cleanup, and real-page evidence
   scoring.
8. Treated a natural click on a native `<option>` as `selectOption`, including pages with duplicate
   visible result text, and reported the compatibility fallback explicitly.
9. Added conditional Playwright delegation with one Terra/medium child only for independent,
   parallelizable browser verification, plus rollout-based decision and configuration scoring.
