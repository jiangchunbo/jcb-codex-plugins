---
name: playwright
description: Automate a real browser for navigation, form interactions, screenshots, data extraction, UI-flow debugging, frontend smoke tests, rendered visual QA, and responsive checks. Use for requests involving Playwright, playwright-cli, browser automation, browser screenshots, or interactive frontend validation. Prefer the persistent playwright-fast MCP and keep fallback runtimes on demand.
---

# Playwright

Use the persistent `playwright-fast` MCP `run` directly. It starts or reuses Chromium, page,
cookies, and local storage; no preliminary `status` is needed. Continue in the same executing
agent after the first browser call. For independent browser verification alongside useful
non-browser work, read [execution-agent.md](references/execution-agent.md) before delegating.

## Compact flow

When controls are known, batch related actions, final reads, and assertions in one call:

```json
{
  "url": "http://127.0.0.1:3000/edit",
  "steps": [{ "op": "click", "target": { "role": "button", "name": "Save" } }],
  "expect": [{ "target": { "text": "Saved" }, "state": "visible" }],
  "evidence": "ultra"
}
```

On an unfamiliar page, use `{"op":"observe","as":"page"}` (or add a scoped `target`) rather
than generating DOM-probing JavaScript. It returns a bounded accessibility snapshot and visible
control metadata. Append observe after known actions in the same run when the next decision needs
new page state. An observation is not proof that asynchronous application data finished loading;
wait for a known resulting control when needed. Then batch dependent actions.
Inspect actual visible controls (tag/role, label, text, placeholder, selected value, and stable
selector as needed); nearby `innerText` alone does not prove a button name or click target.
Prefer `role` with `name`, then `label`, `placeholder`, `testId`, and scoped `css`. Use `within`
for repeated controls and inspect actual options before choosing a select value; a native select
accepts `value:{"label":"visible label"}`. Avoid dumping full-page HTML or the entire DOM.

Use scoped `readText` with `maxChars`, `readValue` for form values, or `evaluate` returning only
named fields needed for the next decision. Whole-body text reads use `textContent` and can include
scripts and hidden content. Scoped `innerText` is useful for rendered content, not target guessing.
Bound logs by both lines and characters (a single line can be huge); return total/returned counts,
truncation status, and the selected window or filter. Preserve row identity, timestamps, labels,
units, errors, and selected values. Read a different bounded window only if the decision needs it.
Do not gzip/base64 evidence or replace a fresh post-action check with cached observations.

For log extraction, see [bounded-reads.md](references/bounded-reads.md). Large output previews may
include `outputArtifact` pointing to the complete local JSON; inspect a relevant slice only when
needed instead of printing the entire artifact back into context.

## Code editors

Use `editorRead` on an explicit editor container or textarea before editing. It returns bounded
text, full-content SHA-256 `hash`, `totalChars`, `truncated`, and the detected adapter. For an exact
change use `editorPatch` with non-empty `oldText`, `newText`, and preferably `expectedHash` from
the read. The old text must occur exactly once; conflicts, ambiguous editors, unsupported adapters,
and read-only editors fail without an intended write. Successful patch results report `changed`
and `verified`; they do not mean the application saved to its server.

```json
{"steps":[{"op":"editorPatch","target":{"css":"#pipeline-editor"},
"oldText":"curl -T ","newText":"curl --fail-with-body --upload-file ","as":"patch"}]}
```

The selector above is an example; select the observed editor. Batch patch, an authorized Save click,
and a known success check when available. Verify persistence after reload. Do not retry a mutation
blindly after a later failure. See [editors.md](references/editors.md) for adapter boundaries.

## Timing and contract essentials

- Keep `domcontentloaded` and locator readiness. Prefer waits for the specific resulting state
  over `networkidle` or fixed sleeps; do not repeatedly sleep and dump the page to discover readiness.
- Top-level `timeoutMs` is the default locator timeout (2 seconds), not the whole-flow deadline.
  Navigation defaults to 5 seconds; explicit operation timeouts cannot exceed 30000 ms. Leave the
  default alone for ordinary reads or sleeps. Increase only a known slow operation's per-step
  timeout. The 50-second contract budget is a static estimate, not an overall wall-clock deadline;
  increasing the locator default can unnecessarily inflate that estimate and reject a valid flow.
- Nest readiness under `target`: `"ready":{"target":{"text":"Ready"},"state":"visible"}`.
  `ready` runs once after entry navigation. After `setContent`, a step-level `goto`, or a later
  action, put the state wait after that step. Hash Router URLs require `/#/...`.
- `fill`/`type` use `value`; `wait` uses `target` or `ms`. An `evaluate` expression must be valid
  JavaScript, preferably a short `() => { ...; return result; }`. Syntax is validated before the
  flow starts; keep expressions small rather than generating deeply nested one-liners.
- `captureResponses` entries require both `url` and `as`. Before using captures, mocks, files,
  frames, popup switching, or locator compatibility behavior, read
  [contracts.md](references/contracts.md) for exact shapes and call-scoped constraints.
- Reuse state. Continuation calls omit top-level `url` to preserve the current page and viewport;
  new-document flows default to 1440×900. Follow repository viewport rules when present.
  `reset` discards state; use only for corruption, explicit isolation, or a user request.

## Evidence and recovery

Choose one tier: `ultra` (default, requested reads/assertions), `health` (also console/page errors),
`visual` (one viewport screenshot), or `diag` (errors, screenshot, failing phase). Use `ultra` for
routine interaction and text/data diagnostics. Use `visual` for visual verification and `diag`
when the screenshot or richer failure context will answer a specific question. Inspect a screenshot
before making visual claims; geometry/computed style can supplement it. `setContent` proves a
synthetic fixture, not real application integration.

Inspect `ok`, `failureKind`, and the failing phase. Fix all `contractErrors` together and rerun the
minimal contract; invalid contracts execute no browser actions or screenshots. A syntax/parameter
failure needs correction, not a diagnostic browser call. For locator failures, inspect the returned `failureObservation` first; it is a bounded, best-effort
read of the current top-level page and may differ from an iframe failure scope. Preserve the page.
For unresolved locator/assertion failures, make one targeted scoped read with `ultra`; use `diag` only when visual evidence or its
extra diagnostics are needed. Multiple matches require a more precise locator, not a longer timeout.
Omit `url` during current-page diagnosis; repeat mock rules only if navigating or fetching again.

A `page`/health failure after a click does not establish that the business action failed. Inspect
the resulting state or receipt before deciding what completed; never automatically replay a save,
submit, login, or other mutation to repair diagnostics or missing response capture. Treat accompanying
`requestFailures` as candidate causes until the data flow connects them to the missing target.
Do not reset a working context to improve networking. When reset is necessary immediately before
another flow, use `reset:true` on that next `run`.

## Conditional references

- Network routing, proxy diagnostics, cache, or connection settings:
  [routing.md](references/routing.md). Automatic routing requires no speed test or per-call status.
- Missing MCP capability or unavailable `run`: [fallbacks.md](references/fallbacks.md), selecting
  the first viable fallback. Do not switch runtimes while MCP can express the flow.
- Missing pinned browser: rerun the repository installer. Do not use unversioned
  `npx playwright install`; `PLAYWRIGHT_EXECUTABLE_PATH` is an explicit override.

Keep narration and tool rounds proportional to the task. Report the real application/harness/fixture,
flow, evidence tier, viewport, observed outcome, and meaningful limitations. Mention screenshots or
errors only when collected; do not add extra viewports, retries, traces, or broad dumps without a
specific need.
