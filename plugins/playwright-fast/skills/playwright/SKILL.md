---
name: playwright
description: Automate a real browser for navigation, form interactions, screenshots, data extraction, UI-flow debugging, frontend smoke tests, rendered visual QA, and responsive checks. Use for every request involving Playwright, playwright-cli, browser automation, browser screenshots, or interactive frontend validation. Prefer the persistent playwright-fast MCP and keep fallback runtimes on demand.
---

# Playwright

Run one real-browser flow with the smallest reliable contract. Default to the persistent
`playwright-fast` MCP and minimal evidence.

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

If MCP `run` is unavailable or lacks a required capability, read
[references/fallbacks.md](references/fallbacks.md) and select the first viable fallback. Do not load
that reference for normal MCP work.

## Build One Reliable Contract

Prefer semantic targets in this order: `role` with `name`, `label`, `placeholder`, `testId`, then
scoped `css`. Scope repeated controls with `within`; add target-level `frame`, `first`, or `nth`
when required. Use a click with `"popup":"switch"` to adopt a new page atomically.

Use `captureResponses` for real response bodies, `goto` for mid-flow navigation, and `evaluate`
only when declarative operations cannot express the action. Use `readValue` for form-control values.
Use `cors:true` for
credential-compatible route responses and OPTIONS handling. Claim that a preflight occurred only
when captured route calls contain `cors-preflight`.

Check these contract shapes before running:

- Nest readiness locators under `target`, for example
  `"ready":{"target":{"text":"Ready"},"state":"visible"}`.
- Top-level `ready` runs after top-level navigation and before every step. When `setContent` or a
  step-level `goto` creates the target, add a later `wait` step instead.
- Treat `routes` and `blockResourceTypes` as call-scoped. Repeat required rules in every contract
  that navigates, reloads, or fetches mocked data.
- Use `json` for structured mock responses and `body` only for text, for example
  `{"routes":[{"url":"**/api/items*","method":"GET","cors":true,"json":{"code":200,"data":[]}}]}`.
- In URL globs, `?` matches one character. Use `**/toc/orders*` to cover the path both with and
  without a query string.
- Use per-step `timeoutMs` only for a known operation that needs a different ceiling.
- Text and button-name clicks automatically use a unique nearest interactive ancestor, including
  `uni-button`, uni-app modal controls, and conventional `*-btn` elements. The result reports this
  under `locatorFallbacks`. When more than one candidate exists, target the component explicitly,
  for example `{"css":"uni-button","hasText":"保存"}`, and scope it with `within` when needed.

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
