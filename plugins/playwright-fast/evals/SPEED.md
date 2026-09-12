# Speed evaluation, 2026-09-11

This evaluation prioritizes successful task completion latency. It compares the locally available
GPT-5.5 low/medium and GPT-5.6 Luna low/medium with the previous Terra/medium recommendation.
The local Codex model catalog exposes GPT-5.5 with low/medium/high/xhigh; no other GPT-5.5 variant
was assumed available. All configurations use the same pinned Playwright 1.63.0 / Chromium
153.0.8010.12 (revision 1243), default service tier in the main matrix, and one model process at a time. A separate
two-case experiment requests priority.

## Measurement boundaries

`observedAtMs` records receipt of complete CLI JSONL events. We measure first browser tool start,
union of tool execution intervals, non-tool wall time, usage tokens, and end-to-end effective output
token/s. Non-tool time includes startup, context prefill, queueing, transport, reasoning, generation,
and shutdown. Neither isolated thinking duration nor decoder token/s is exposed by this CLI;
those fields are null. Reported reasoning output tokens are retained when available. Effective
output token/s is not a stand-alone ranking: extra unnecessary generation can increase it while
making the task slower. Input usage accumulates over multiple model calls and is not context size.

The original smoke runner referenced `$playwright` while prohibiting file reads; skill loading was
not verified. Its results are a discovery baseline, not evidence of compliance with the skill.
`--inline-skill` includes the repository skill explicitly and saves its snapshot and hash in the run
folder. Do not attribute a before/after improvement solely to instruction edits: delivery also changed.
Runs are interleaved by task in the revised runner. Sample sizes are exploratory; P95 with three
samples is simply their maximum. We did not control server load or prompt cache warmth.

## Task design and external references

- [BrowserGym](https://github.com/ServiceNow/BrowserGym) integrates browser microtasks and longer
  workflows, including MiniWoB, WebArena and WorkArena.
- [WebArena](https://github.com/web-arena-x/webarena) motivates functional goal checking in realistic
  self-hosted applications.
- This suite uses local, original fixtures; these are **not official benchmark tasks or scores**.
  Easy tasks cover native form controls; medium tasks cover custom controls, frames, popups,
  asynchronous results and diagnostics. The hard procurement fixture requires comparing two pages,
  applying three constraints, selecting the cheapest eligible product, confirming an order and
  checking persistence after reload. A fixture oracle validates the submitted fields independently
  of the agent's answer. This small task does not establish long-horizon WebArena performance.

## Optimization rationale

[OpenAI GPT-5.5 guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.5)
recommends benchmarking accuracy, token consumption and end-to-end latency, with reasoning controls,
concise outputs and reusable prompt prefixes. [Playwright's navigation documentation](https://playwright.dev/docs/api/class-page#page-goto)
discourages networkidle for testing and recommends assertions for readiness.

The discovery runs showed guessed select values, 10-second waits, unrequested screenshots and
multiple narration/tool rounds. The revised skill selects native options by visible label, preserves
short default timeouts, uses scoped evidence, and batches operations after necessary discovery.
The browser runtime and default evidence tier already provide fast reuse; no version change is
justified by these measurements.

## Browser and information density measurements

30 hot read/assertion contracts on a synthetic page:

| Evidence | Cold startup + first contract | Hot P50 | Hot P95 |
|---|---:|---:|---:|
| ultra | 613.3 ms | 3.0 ms | 7.0 ms |
| visual | 514.3 ms | 33.2 ms | 37.6 ms |

Cold results are single samples; their difference is not a tier effect. Visual measures screenshot
production, not the model's image processing cost, and does not establish layout quality.

The order fixture's serialized evidence measured 667 characters for body textContent, 51 for
rendered innerText, and 23 for the result row (92.4% and 96.6% reductions). These are character
counts, not tokenizer counts. The row alone suffices to read the amount but cannot describe form
controls. Keep labels, identity, units, errors and selected values for the task at hand. Compression
is lossy and must be scoped to the next decision; gzip/base64 is not a model-context optimization.

Reproduce these local checks with `benchmark-hot-run.js --iterations=30 --evidence=ultra`, the same
command with `--evidence=visual`, and `benchmark-evidence.js` in this directory.

Learned token pruning such as [LLMLingua-2](https://www.microsoft.com/en-us/research/publication/llmlingua-2-data-distillation-for-efficient-and-faithful-task-agnostic-prompt-compression/)
is another researched option. We have not benchmarked it here. It requires a separate compressor;
its latency and preservation of exact browser labels, values and selectors would need validation.
For these small fixtures, deterministic rendered-text/field extraction is the implemented choice.

## Model results

The 15 discovery smoke runs and 15 explicit-skill runs all completed their functional goals.
The comparison below uses only the explicit-skill runs; each cell is one observation.

| Configuration | Form seconds (calls) | Frame/popup seconds (calls) | Procurement seconds (calls / failed calls) |
|---|---:|---:|---:|
| gpt-5.5@low | 26.0 (1) | 30.0 (2) | 121.2 (8 / 3) |
| gpt-5.5@medium | 44.7 (3) | 30.6 (2) | 64.7 (4 / 0) |
| gpt-5.6-luna@low | 24.2 (2) | 27.2 (3) | 56.8 (8 / 2) |
| gpt-5.6-luna@medium | 26.7 (2) | 35.7 (4) | 50.0 (7 / 0) |
| gpt-5.6-terra@medium | 31.9 (3) | 36.8 (4) | 66.8 (6 / 2) |

All procurement runs must also expose matching receipt evidence after an executed reload, not just a correct submitted order. Later unrelated locator failures do not erase already observed receipt evidence, but are counted as failed calls.

| Configuration | First browser action P50 seconds | Output tokens P50 | Reasoning tokens P50 | Effective output tokens/s P50 |
|---|---:|---:|---:|---:|
| gpt-5.5@low | 17.0 | 679 | 57 | 22.6 |
| gpt-5.5@medium | 16.8 | 1534 | 253 | 34.3 |
| gpt-5.6-luna@low | 14.3 | 669 | 181 | 24.6 |
| gpt-5.6-luna@medium | 13.5 | 948 | 335 | 27.4 |
| gpt-5.6-terra@medium | 14.5 | 996 | 350 | 31.2 |

The effective token rate is higher for some slower configurations because they generated more tokens. Rank by successful task latency and recovery burden, not this rate alone.

## Requested priority tier

Luna/low passed both additional cases when priority was requested: form 20.961 s (default 24.157 s),
frame/popup 19.923 s (default 27.189 s). These are unpaired single observations with uncontrolled
cache/server load, not proof of a fixed tier speedup. The CLI exposes the requested configuration,
not a returned server-side service tier. No global tier setting was changed.

## Skill decision

Use Luna/low for routine browser subagents and Luna/medium for multi-page constrained comparisons
or chained review/confirmation/persistence flows. On this procurement task medium completed in
50.042 s with zero failed calls; low took 56.763 s with two failed calls. Honor explicit model and
effort choices. For a user-selected GPT-5.5, prefer low for routine tasks and medium for these
complex flows (64.662 s without failures versus low's 121.169 s with three failures).

The final skill also scopes success checks to the receipt/result container, so a hidden option
with identical text does not capture the locator; and places later-state waits after their creating
action rather than using a top-level readiness condition that fails earlier in the flow. The model
matrix used the saved pre-selection skill snapshot; the final model selection is validated separately
through the delegation test. The targeted waiting clarification is supported by observed failures,
but its incremental latency effect was not isolated in another full model matrix.

These are provisional local defaults supported by 32 browser-agent runs (15 discovery, 15 explicit
skill, two requested-priority). Each configuration/task pair has only one observation per stage;
repeat across more applications before treating small differences as durable. The browser version
was deliberately held fixed because warm execution is milliseconds while model turns dominate.

Final delegation validation: one GPT-5.5/low parent correctly spawned a Luna/low child for independent browser verification. Configuration, execution lane, fixture oracle and final result passed (65.705 s including parent audit and delegation). The 12 evaluator/runtime-fixture checks and skill validation also passed. These repository changes have not been published or copied into the installed plugin cache.
