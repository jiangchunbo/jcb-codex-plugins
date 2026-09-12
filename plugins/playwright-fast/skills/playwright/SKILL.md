---
name: playwright
description: Automate a real browser for navigation, form interactions, screenshots, data extraction, UI-flow debugging, frontend smoke tests, rendered visual QA, and responsive checks. Use for every request involving Playwright, playwright-cli, browser automation, browser screenshots, or interactive frontend validation. Prefer the persistent playwright-fast MCP and keep fallback runtimes on demand.
---

# Playwright

Run one real-browser flow with the smallest reliable contract. Default to the persistent
`playwright-fast` MCP and minimal evidence.

## Choose The Execution Agent

Execute in the current agent when browser work is the user's primary task, the current task was
already delegated as a browser-only task, a Playwright call has established page or login state,
the next action depends on the same failure state, or the parent has no useful non-browser work to run
at the same time. Continue in the same agent after the first Playwright call; do not transfer a live
flow or assume that another agent shares its browser state.

Delegate browser work only when it is a bounded, independent verification inside a larger task and
the parent can continue useful non-browser work concurrently, or when multiple browser targets are
independent and share no state. When either condition is met, delegation is required. Before
starting the parent's parallel work, call `spawn_agent`
exactly once for each independent browser target; do not merely announce delegation or call `wait`
without a successfully returned child id. Use the collaboration subagent tool, not a user-owned
task, with:

- `model: "gpt-5.6-luna"`
- `reasoning_effort: "low"` for routine controls, reads, and frame/popup flows; choose `"medium"`
  before starting multi-page constraint comparisons or chained review/confirmation/persistence tasks
- no inherited conversation: use `fork_turns: "none"` when that field is available, or the
  equivalent `fork_context: false` on collaboration APIs that expose that field instead
- a unique lowercase `task_name` describing the browser target when the API requires it

These defaults prioritize observed task latency. Honor an explicitly requested model or effort.
For GPT-5.5, use low for routine flows and medium for the multi-stage tasks above. Do not infer
that fewer reasoning tokens or higher token/s necessarily means faster completion.

Give the subagent a self-contained task containing the URL, actions, acceptance result, allowed
fixtures or fake data, and required evidence. Tell it to use Playwright Fast directly, not modify
business source, and not delegate again. A Playwright-dedicated subagent always executes directly.

Do not automatically select `high`, `xhigh`, `max`, or a different model after a failure. Keep the
single targeted diagnostic in the same executing agent. If collaboration or the requested model is
unavailable, do not retry delegation; execute the browser task in the current agent.

## Run The Persistent MCP First

Call the `run` tool from the `playwright-fast` MCP directly. Do not call `status` first; `run`
starts or reuses Chromium automatically. Do not select Browser, `js_repl`, JSONL, a repository
runner, or the CLI while MCP `run` is available and can express the requested flow.

Batch navigation, authentication fixtures, request mocks, interactions, reads, and assertions into
one call:

```json
{
  "id": "save",
  "url": "http://127.0.0.1:3000/edit",
  "viewport": { "width": 1440, "height": 900 },
  "steps": [{ "op": "click", "target": { "role": "button", "name": "Save" } }],
  "expect": [{ "target": { "text": "Saved" }, "state": "visible" }],
  "evidence": "ultra"
}
```

Use the MCP tools as follows:

- `run`: execute one contract while reusing browser, context, page, cookies, and local storage.
- `reset`: discard runtime state only after corruption, explicit isolation, or a user request.
- `status`: inspect warmth and the 30-minute idle TTL only when that state matters.

The MCP automatically learns direct versus inherited HTTP/HTTPS proxy connection quality locally.
Do not run a speed test or query `status` before each call. Without a supported inherited proxy it
stays direct and starts no relay or probes. Local, private, and `NO_PROXY` targets stay direct.
Routes remain fixed within the browser context except for connection failure before request/tunnel
delivery; a faster measured route applies to the next context. The relay never replays business
requests. Do not reset a working context just to obtain a faster route.

Use `status` or `diag` routing summaries only to diagnose network behavior. An explicit
`reset` with `{"clearRouting":true}` discards learned statistics as well as browser state;
ordinary reset retains statistics. Set `PLAYWRIGHT_FAST_ROUTING=off` before server startup to
restore the previous browser networking behavior. This controls browser traffic only, not model
API routing or model speed tiers. For routing limitations, cache details, and troubleshooting,
read [references/routing.md](references/routing.md).

Routing diagnostics include separate connection phases and top-level navigation wait timing.
Do not treat them as model thinking time or page throughput. The experimental
`PLAYWRIGHT_FAST_CONNECT_RACE=on` setting competes only for a target's first connection in the
context after 250 ms; it defaults off. No extra model-side probe or retry is needed.

The MCP uses a local PAC configuration to distinguish WS from WSS before CONNECT. WS uses the
HTTP proxy setting and WSS uses HTTPS; missing settings remain direct. HTTP connections are reused
within the context and route. If a later check fails after a form was saved, report the partial
outcome and do not replay the workflow automatically.

The repository installer provisions the plugin's pinned Playwright and Chromium runtime. Do not
repair a missing browser with an unversioned `npx playwright install`; rerun the repository
installer so the library and browser revision stay aligned. `PLAYWRIGHT_EXECUTABLE_PATH` is an
explicit system-browser override, not the default launch path.

If MCP `run` is unavailable or lacks a required capability, read
[references/fallbacks.md](references/fallbacks.md) and select the first viable fallback. Do not load
that reference for normal MCP work.

## Keep Model Turns and Evidence Small

Optimize successful end-to-end completion, not token/s alone: extra reasoning, narration, tool
round trips, and recovery can outweigh browser runtime. For a short flow, give one brief progress
update and the final observed result; add updates when work runs long or a material failure changes
what the user needs to know.

When controls are known, batch actions and final reads. On an unfamiliar page, take one scoped
read to discover controls, then batch the dependent actions. Do not guess hidden option values:
for a native select, use `value: {"label":"visible option label"}` or first inspect actual options.
Scope success checks to the result/receipt container so hidden options with the same text do not
win the match. A top-level `ready` must remain valid before every step; put waits for later states
after the action that creates them. Keep `domcontentloaded` and locator-based readiness; use neither `networkidle` nor fixed sleeps
unless a specific requirement justifies them. Do not increase timeouts to compensate for an
unverified locator or guessed value.

Read the smallest relevant container, bound text with `maxChars`, and return only fields needed
for the next decision. Whole-body `readText`/`readAllText` uses textContent and can include scripts
and hidden text: for rendered discovery, use a scoped `evaluate` returning `element.innerText`,
or extract named table/form fields. Preserve labels, row identity, units, errors, and selected
values when compressing evidence. Do not summarize away distinctions needed to choose a target,
encode evidence as gzip/base64, or substitute cached observations for a fresh post-action check.

## Build One Reliable Contract

Prefer semantic targets in this order: `role` with `name`, `label`, `placeholder`, `testId`, then
scoped `css`. Scope repeated controls with `within`; add target-level `frame`, `first`, or `nth`
when required. Use a click with `"popup":"switch"` to adopt a new page atomically.

Use `captureResponses` for real response bodies, `goto` for mid-flow navigation, `reload` to refresh
the current page, `setInputFiles` with absolute paths for uploads, and `evaluate` only when
declarative operations cannot express the action. Use `readValue` for form-control values and
`maxChars` on text reads when the page can be large. If `readValue` targets a non-form value
display, the runtime returns its text content and reports the compatibility fallback.
Use `cors:true` for
credential-compatible route responses and OPTIONS handling. Claim that a preflight occurred only
when captured route calls contain `cors-preflight`.

Keep common action shapes simple: `fill` and `type` use `value`; `wait` uses either `target` or
`ms`. The runtime also accepts the common `text` alias for fill/type, `waitForTimeout` with
`timeoutMs`, step-level `first`/`nth`, and `paths` as an alias for `setInputFiles.files`, so a
familiar Playwright-shaped contract does not need a repair call.

Check these contract shapes before running:

- Nest readiness locators under `target`, for example
  `"ready":{"target":{"text":"Ready"},"state":"visible"}`.
- Top-level `ready` runs after top-level navigation and before every step. When `setContent` or a
  step-level `goto` creates the target, add a later `wait` step instead.
- Same-document navigation, including Hash Router changes, automatically yields for two animation
  frames. Still use a later target wait when the application performs additional asynchronous work.
- Treat `routes` and `blockResourceTypes` as call-scoped. Repeat required rules in every contract
  that navigates, reloads, or fetches mocked data.
- Use `json` for structured mock responses and `body` only for text, for example
  `{"routes":[{"url":"**/api/items*","method":"GET","cors":true,"json":{"code":200,"data":[]}}]}`.
- In URL globs, `?` matches one character. Use `**/toc/orders*` to cover the path both with and
  without a query string.
- Use per-step `timeoutMs` only for a known operation that needs a different ceiling.
- Required response captures share the run clock and wait concurrently. Their timeouts do not add
  serially to the contract budget.
- Text and button-name clicks automatically use a unique nearest interactive ancestor, including
  `uni-button`, uni-app modal controls, and conventional `*-btn` elements. The result reports this
  under `locatorFallbacks`. When more than one candidate exists, target the component explicitly,
  for example `{"css":"uni-button","hasText":"保存"}`, and scope it with `within` when needed.
- When an action or single-value read has exactly one visible match, the runtime ignores its hidden
  duplicates. Clicks also fall back from a custom control's rendered placeholder text and from a
  covered read-only combobox input to its control container; these non-force fallbacks are reported
  in `locatorFallbacks`.
- Text and label targets without an explicit `exact` setting retry one substring match when no exact
  match exists; ambiguous matches still fail normally.

New-document flows default to a `1440x900` viewport. Continuation contracts without a top-level
`url`, `goto`, or `setContent` preserve the current viewport, including targeted diagnostics. The
runtime otherwise uses a 2-second locator timeout, 5-second navigation and screenshot timeout,
`domcontentloaded`, reduced motion, blocked service workers, and a 30-minute idle TTL. Follow
repository viewport rules when they differ. Read the router configuration before choosing a URL;
Hash Router routes require `/#/...`.

Reuse existing browser state. Provide cookies and origin-scoped `localStorage` in the contract when
that avoids repeating login. Persistent browser state does not make network fixtures persistent.

## Select One Evidence Tier

Use exactly one tier:

- `ultra` (default): requested assertions only.
- `health`: assertions plus console and page errors.
- `visual`: assertions plus one viewport screenshot, including when the flow fails. Inspect that
  screenshot before making layout or visual claims.
- `diag`: errors, one screenshot, and the failing phase. Use only after failure or when explicitly
  requested.

Do not add a second viewport, screenshot, retry, trace, accessibility sweep, network log, or broad
DOM dump unless the request requires it. Use geometry or computed-style observations as well as one
inspected screenshot for layout claims. Treat `setContent` as synthetic fixture evidence, not proof
that the real application integrated correctly.

## Escalate Once

Fix `contract` failures and rerun the same minimal contract. For one valid-contract `locator`,
`assertion`, `navigation`, `network`, `page`, or `runtime` failure, preserve the browser and current page, then
run one targeted `diag` contract. Omit top-level `url` when diagnosing the rendered page. Repeat
route rules only when diagnosis navigates or reloads.

Treat `requestFailures` accompanying a locator failure as candidate causes until the application
data flow proves they feed the missing target. Do not reset merely to change routes. When a reset is
necessary and another flow follows immediately, set `reset:true` on that next `run`.

Always inspect the returned `ok` field. Locator, assertion, navigation, network, and page failures
are completed tool calls with `ok:false`; malformed contracts and runtime faults are tool errors.

## Report Compactly

State whether the target was the real application, a component harness, or a synthetic fixture.
Include the tested flow, evidence tier, viewport, observed assertions or measurements, and relevant
exclusions. Mention screenshots or errors only when the selected tier collected them.
