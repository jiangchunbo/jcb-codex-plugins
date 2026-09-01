---
name: playwright
description: Automate a real browser for navigation, form interactions, screenshots, data extraction, UI-flow debugging, frontend smoke tests, rendered visual QA, and responsive checks. Use for every request involving Playwright, playwright-cli, browser automation, browser screenshots, or interactive frontend validation. Prefer the persistent playwright-fast MCP and always use this skill together with playwright-efficient.
---

# Playwright

Drive one real-browser flow with the smallest possible contract. Let `playwright-efficient` choose the evidence tier and scheduling policy.

## Use The Persistent MCP First

Call the `run` tool from the `playwright-fast` MCP directly. Do not call `status` first; `run` starts or reuses Chromium automatically. Batch navigation, authentication fixtures, request mocks, interactions, reads, and assertions into one tool call.

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

Use these tools only:

- `run`: execute one flow contract and reuse browser, context, page, cookies, and local storage. Request routes and resource blocking are installed only for that call and removed before it returns.
- `reset`: discard runtime state only after corruption, explicit isolation, or a user request.
- `status`: diagnose warmth and the 30-minute idle TTL only when that state matters.

When a locator wait fails after an XHR or fetch failure, `run` keeps `failureKind: "locator"` and includes compact `requestFailures` as a possible cause, not a proven cause. Check whether the failed request feeds the target before changing mocks or locator timeouts. If runtime state must be discarded and another flow will run immediately, set `reset:true` on that next `run` instead of spending a separate `reset` round trip.

Prefer semantic targets: `role` with `name`, `label`, `placeholder`, `testId`, then scoped `css`. Scope repeated controls with `within`; use target-level `frame`, `first`, or `nth` when needed. A click with `"popup":"switch"` atomically adopts a new page. Use `captureResponses` for real response bodies, `goto` for mid-flow navigation, and `evaluate` only as an escape hatch. Use `cors:true` to add credential-compatible headers and handle OPTIONS requests surfaced by Playwright; claim that a preflight occurred only when captured route calls contain `cors-preflight`. Use per-step `timeoutMs` only when a known operation needs a different ceiling.

Top-level `ready` uses the same expectation shape as one `expect` entry, so locator readiness must nest the locator under `target`: `"ready":{"target":{"text":"Ready"},"state":"visible"}`. It runs after top-level navigation and before every `steps` entry. When `setContent` or `goto` in `steps` creates the target state, use a later `wait` step instead of top-level `ready`.

Persistent browser state does not make network fixtures persistent. Repeat every required `routes` rule in each `run` that navigates, reloads, or otherwise fetches the mocked data. Do not use `reset` merely to change route rules; the next call installs its own rules. In URL globs, `?` matches exactly one character rather than making the query string optional, so `**/toc/orders?*` does not match `/toc/orders`; use `**/toc/orders*` when both forms are in scope.

The runtime defaults to a `1440x900` viewport, 2-second locator timeout, 5-second navigation timeout, `domcontentloaded`, reduced motion, blocked service workers, and a 30-minute idle TTL. Follow repository viewport rules when they differ.

Reuse the task's existing browser state, or provide the needed cookies and origin-scoped `localStorage` through the flow contract when that avoids repeating login.

## Fall Back Through The JSONL Driver

When the MCP tool is unavailable or lacks a required capability, use the persistent JSONL driver from `playwright-efficient` before the CLI. The driver is the normal local fallback; the CLI is last resort only.

Before CLI use, verify `npx` once, then use one named session and one `run-code` flow where possible:

```bash
command -v npx >/dev/null 2>&1
PLAYWRIGHT_WRAPPER="${CODEX_HOME:-${HOME}/.codex}/skills/playwright/scripts/playwright_cli.sh"
test -x "$PLAYWRIGHT_WRAPPER"
PLAYWRIGHT_CLI_SESSION=fast "$PLAYWRIGHT_WRAPPER" open https://example.com
```

When the CLI uses element refs, snapshot first and refresh refs after navigation or substantial DOM changes. Preserve the MCP state for one targeted diagnostic before falling back.
