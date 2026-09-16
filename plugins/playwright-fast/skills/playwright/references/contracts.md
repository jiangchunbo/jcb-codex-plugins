# Advanced contracts

For a real login response, register the capture in the same call as the single submit action:

```json
{
  "url": "http://127.0.0.1:3000/#/login",
  "steps": [
    { "op": "fill", "target": { "label": "Username" }, "value": "demo" },
    { "op": "fill", "target": { "label": "Password" }, "value": "fixture-password" },
    { "op": "click", "target": { "role": "button", "name": "Log in" } }
  ],
  "captureResponses": [{
    "url": "**/api/login", "method": "POST", "as": "login",
    "body": "json", "required": true, "timeoutMs": 10000
  }],
  "evidence": "health"
}
```

Each capture requires `url` and `as`; its output contains `url`, `method`, `status`, and `body`.
There is no JSON field projection: select the few needed fields when reporting the captured body.
`maxBodyBytes` rejects oversized bodies; it does not truncate or select fields. Capture deadlines
start when listeners are installed, before navigation and actions, using the capture's `timeoutMs`
or the default locator timeout. Budget for the preceding actions as well as the response.
`required:false` does not wait for a future matching response; it returns an already observed
capture or `null` (an empty array when `count` is greater than one), while still awaiting body reads
already in flight up to the capture deadline. At expiry it returns only completed captures. Do not submit again to repair a missing capture after login was triggered.

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
- Top-level `ready` is checked once after entry navigation, not before every step. When `setContent`
  or a step-level `goto` creates the target, add a later `wait` step instead.
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
`url`, `goto`, or `setContent` preserve the current viewport, including targeted diagnostics.
Top-level `timeoutMs` sets the default locator timeout, not a whole-flow deadline; it defaults to
2 seconds. Navigation defaults to 5 seconds, and explicit operation timeouts are capped at
30 seconds. The runtime otherwise uses a 5-second screenshot timeout,
`domcontentloaded`, reduced motion, blocked service workers, and a 30-minute idle TTL. Follow
repository viewport rules when they differ. Read the router configuration before choosing a URL;
Hash Router routes require `/#/...`.

Reuse existing browser state. Provide cookies and origin-scoped `localStorage` in the contract when
that avoids repeating login. Persistent browser state does not make network fixtures persistent.

