---
name: playwright-efficient
description: Execute aggressively speed-first Playwright work with persistent browser runtimes, 250 ms tool yields, batched JSONL contracts, and deliberately minimal evidence. Always use this skill for every task that uses or requests Playwright, playwright-cli, browser automation, browser screenshots, frontend smoke tests, rendered UI debugging, interaction checks, or responsive QA, including simple or one-off tasks. Use it together with the playwright skill whenever that skill applies.
---

# Efficient Playwright

Optimize end-to-end wall time, tool round trips, and output size. Default to `ULTRA`; expand proof only when the request or a failure requires it.

When `playwright` also applies, follow it for browser prerequisites, CLI fallback, and artifact rules. The JSONL driver uses explicit locators instead of CLI element refs, so CLI snapshot rules apply only when using CLI ref commands.

Reduce validation coverage, not environment permissions, authentication boundaries, or product safety controls.

## Choose The Fastest Runtime

Use this order:

1. Reuse an available persistent Browser or `js_repl` runtime.
2. Otherwise start the bundled JSONL driver once and reuse its browser, context, and page.
3. Use a configured repository test runner only when its fixtures or repeatability are required.
4. Use the `playwright` skill CLI wrapper only as a fallback.

Never install dependencies when an existing runtime works.

## Apply The Scheduling Contract

Start the driver in a PTY-backed persistent terminal. The launcher disables terminal echo so JSON requests are not repeated in output:

```bash
PLAYWRIGHT_DRIVER="${CODEX_HOME:-${HOME}/.codex}/skills/playwright-efficient/scripts/playwright_driver.sh"
test -x "$PLAYWRIGHT_DRIVER"
"$PLAYWRIGHT_DRIVER"
```

Apply these tool settings when they are available:

- start the persistent driver with `tty: true` and `yield_time_ms: 500`
- send each non-empty JSONL request with `yield_time_ms: 250`
- when startup returns no `ready` line, immediately queue `{"command":"ping"}` or the first contract; do not empty-poll because unified empty polls may wait 5 seconds
- poll once only when a non-empty request returns without a complete result line
- never copy Playwright navigation or locator timeouts into the terminal tool wait
- close once with `{"command":"close"}` after every flow is complete

The driver emits exactly one compact JSON line for readiness and one for each request. Do not bypass the launcher's `stty -echo`; echoed input wastes time and output tokens.

## Send One Flow Contract

Batch navigation, interaction, reads, assertions, and optional evidence into one request:

```json
{"id":"save","url":"http://127.0.0.1:3000/edit","viewport":{"width":1440,"height":900},"steps":[{"op":"click","target":{"role":"button","name":"Save"}}],"expect":[{"target":{"text":"Saved"},"state":"visible"}],"evidence":"ultra"}
```

Supported targets:

- `{"role":"button","name":"Save"}`
- `{"text":"Saved"}`, `{"label":"Name"}`, `{"placeholder":"Search"}`
- `{"testId":"save"}` or `{"css":".status"}`
- scope repeated controls to an ancestor with `within`; add `hasText` to that ancestor for multi-field rows, for example `{"role":"button","name":"Sign in","within":{"css":"tr","hasText":["13900000000","Administrator"]}}`
- add `frame`, `first`, or `nth` when needed; frames accept exact `name`, partial `urlIncludes`, or iframe `css`

Semantic locator names are exact by default. Ensure decorative fixture icons use `aria-hidden="true"`; otherwise use the real accessible name, `exact:false`, a test id, or scoped CSS deliberately.

Supported steps:

- `goto` with `url` for mid-flow navigation
- `setContent`, `click`, `fill`, `clear`, `type`, `press`, `select`
- `check`, `uncheck`, `hover`, `focus`, `wait`; use targetless `ms` only for a known debounce or animation
- `readText`, `readAllText`; use `as` to name returned values
- `readAttribute` with `attribute`, for example `{"op":"readAttribute","target":{"css":".save"},"attribute":"class","as":"className"}`
- `readBoundingBox` for `x`, `y`, `width`, `height`, `right`, and `bottom`
- `readComputedStyle` with `properties`, for example `{"op":"readComputedStyle","target":{"css":".footer"},"properties":["display","padding-top"],"as":"footerStyle"}`
- add `"popup":"switch"` to a click that opens a new page; the runtime waits atomically and continues on the popup
- use `evaluate` with a JavaScript expression or function expression, optional JSON `arg`, `as`, and optional `frame` only when declarative steps cannot express the operation

Supported expectations:

- locator `state`, exact `text`, `contains`, `value`, or `count`
- `attribute` as `{"name":"aria-disabled","value":"true"}`
- exact computed styles as `{"computedStyle":{"display":"flex"}}`
- numeric geometry as `{"box":{"width":{"min":70,"max":80},"bottom":{"approx":650,"tolerance":1}}}`; a number means approximate equality within `0.5`
- exact or partial `url` and `title`

Use declarative `cookies`, origin-scoped `localStorage`, and first-match `routes` to exercise the real application without touching backend data:

```json
{"id":"modal","url":"http://127.0.0.1:3000/modal","localStorage":[{"origin":"http://127.0.0.1:3000","name":"qa-session","value":"true"}],"routes":[{"url":"**/api/modal","method":"POST","requestBody":{"kind":"detail"},"cors":true,"json":{"code":200,"data":[]}}],"steps":[{"op":"click","target":{"role":"button","name":"Open"},"timeoutMs":3000}],"expect":[{"target":{"role":"dialog"},"state":"visible"}],"evidence":"visual"}
```

Route rules accept `url` glob, optional `method`, partial-JSON `requestBody` or string `requestBodyIncludes`, and one of `json`, `body`, or `abort`. Set `cors:true` to fulfill matching OPTIONS preflights and add response CORS headers. Optional `status`, `headers`, and `contentType` customize fulfillment. Set `captureRouteCalls:true` only when matched-request evidence is needed.

Use `captureResponses` when the result comes from a real network response. Listeners are installed before navigation and steps; each rule uses a URL glob, optional method, `json` or `text` body, and an `as` output key:

```json
{"captureResponses":[{"url":"**/api/share-list","method":"GET","body":"json","as":"shareList"}]}
```

One match is required by default. Set `count` for repeated calls, `required:false` for best-effort capture, or `maxBodyBytes` to change the 1 MB body limit. Each result includes `url`, `method`, `status`, and parsed `body`; responses with non-text content types do not count as matches.

`localStorage` entries are injected before navigation and retained in the persistent context until `reset`. Use the exact origin, including scheme, host, and port. When authentication is represented in client-side state, seed the required `localStorage` entries before navigation to avoid repeating the login flow.

Use `reset: true` only when state isolation is required. Reusing context and the current page is faster.

## Preserve Evidence Integrity

Navigate to the actual application route or an established component-test harness for application claims. Use `setContent` only for a browser-primitive or isolated style microtest, and report it as a fixture test; never present copied HTML or CSS as proof that a framework component rendered or integrated correctly.

For layout claims, collect geometry or computed-style observations and inspect the single `visual` or `diag` screenshot with the available image-view tool before reporting success. Element counts prove presence only, not position, sizing, or visual fidelity.

## Select One Evidence Tier

Evidence tiers are exclusive contracts, not cumulative suggestions:

- `ultra` (default): requested assertions only; no console scan or screenshot
- `health`: assertions plus console/page errors; errors fail the request
- `visual`: assertions plus one viewport screenshot; no console scan
- `diag`: errors plus one screenshot and the failing phase; use only after failure or when explicitly requested

Do not add a second viewport, screenshot, retry, trace, accessibility sweep, network log, or broad DOM dump unless the chosen tier requires it.

## Use Aggressive Defaults

- Use one coherent request per user flow.
- Use 2 second locator and 5 second navigation failure ceilings for local work.
- Navigate with `domcontentloaded`; never use `networkidle` by default.
- Read the repository router configuration before choosing an entry URL. Hash Router routes require `/#/...`; a redirect to login after using `/...` is a contract error, not product evidence.
- Trust known semantic locators, scoped CSS, or test ids without discovery snapshots.
- Prefer application contracts such as `data-testid` and `data-app-ready`.
- Reuse an already-running server. If a package-manager command attempts installation, auditing, or lockfile mutation, stop it and use an equivalent existing local binary only when its mode and arguments are known.
- Block `font` or `media` resources only for non-visual flows by passing `blockResourceTypes`.
- Reuse existing storage state when it helps keep the flow fast and consistent.
- Allow direct DOM reads for state probes. Keep a real locator-driven action only when the claim is about user interaction.

## Escalate Once

Use `failureKind` from the driver result. Correct `contract` failures and rerun the same minimal contract; they do not consume the application diagnostic allowance. On a valid-contract `locator`, `assertion`, `navigation`, `page`, or `runtime` failure, preserve the browser and current page, then run one targeted `diag` contract against that state. Do not restart the browser, rediscover the whole page, or rerun the full suite unless the failure invalidated runtime state.

## Fall Back To CLI

Before CLI use, verify `npx` once:

```bash
command -v npx >/dev/null 2>&1
PLAYWRIGHT_WRAPPER="${CODEX_HOME:-${HOME}/.codex}/skills/playwright/scripts/playwright_cli.sh"
test -x "$PLAYWRIGHT_WRAPPER"
```

Use one named CLI session per coherent flow and keep operations in as few `run-code` calls as practical. For a new session, call `open` once before its first `run-code`; later `run-code` calls reuse the same browser and page state. A `run-code` callback receives `page` directly, so use `async (page) => { ... }`, not `async ({ page }) => { ... }`. Set `page.setDefaultTimeout(5000)` and `page.setDefaultNavigationTimeout(5000)` at the start of each callback; the CLI daemon otherwise defaults locator waits to 30 seconds. Use separate commands only for ref discovery or targeted failure diagnosis. Wait for each unified command session to complete before issuing the next command; never launch `close`, `open`, and `run-code` in a loop that discards returned session IDs.

## Report Compactly

Report whether the target was the real application, a component harness, or a synthetic fixture. Include the tested flow, evidence tier, viewport, observed assertions or measurements, internal elapsed time, and exclusions. Mention screenshots or errors only when the selected contract collected them, and do not upgrade failed or uninspected evidence into a passing claim.
