# Playwright Fallbacks

Read this reference only when the `playwright-fast` MCP `run` tool is unavailable or lacks a
required capability. Preserve any useful MCP page state for one targeted diagnostic before
switching runtimes.

## Choose A Fallback

Use the first viable option:

1. Start the bundled persistent JSONL driver and reuse its browser, context, and page.
2. Use the repository's Playwright test runner when its fixtures, reporting, or repeatability are
   required.
3. Use the bundled raw REPL for a targeted operation that neither the MCP nor JSONL contract can
   express.
4. Use the Playwright CLI wrapper as the last resort.

Do not install dependencies when an existing runtime works.

Resolve every bundled script relative to the directory containing the currently loaded
`playwright/SKILL.md`. Set that absolute directory as `PLAYWRIGHT_SKILL_DIR`; do not assume the
Skill lives under `$CODEX_HOME/skills`, because plugin-installed Skills normally load from a
versioned cache path.

## Run The JSONL Driver

Start one PTY-backed process:

```bash
PLAYWRIGHT_DRIVER="$PLAYWRIGHT_SKILL_DIR/scripts/playwright_driver.sh"
test -x "$PLAYWRIGHT_DRIVER"
"$PLAYWRIGHT_DRIVER"
```

Use these terminal settings when available:

- Start with `tty: true` and `yield_time_ms: 500`.
- Send each non-empty JSONL request with `yield_time_ms: 250`.
- If startup returns no `ready` line, send `{"command":"ping"}` or the first contract immediately.
  Do not empty-poll, because an empty unified poll can wait five seconds.
- Poll once only when a non-empty request returns without a complete result line.
- Keep Playwright timeouts inside the contract; do not copy them to terminal wait settings.
- After all flows, send `{"command":"close"}` once and wait for `{"type":"closed"}`.

The driver accepts the same flow contract as MCP `run` and emits one compact JSON line for
readiness and one per request. Batch the full flow, keep `evidence:"ultra"` by default, repeat
call-scoped routes, and use the same failure policy from the main Skill. The launcher disables
terminal echo; do not bypass it.

## Use The Repository Runner

Use a configured repository runner only when its fixtures or repeatability materially help. Reuse
an installed local binary and the repository's existing command. Stop if a package-manager command
tries to install packages, audit dependencies, or mutate a lockfile.

## Use The Raw REPL

For one capability that the JSONL schema cannot express, start:

```bash
PLAYWRIGHT_REPL="$PLAYWRIGHT_SKILL_DIR/scripts/playwright_repl.sh"
test -x "$PLAYWRIGHT_REPL"
"$PLAYWRIGHT_REPL"
```

Reuse the exposed `browser`, `context`, and `page`. Keep the interaction targeted, then exit the
REPL once. Do not use it to rediscover a flow already expressible as a contract.

## Fall Back To CLI

Verify `npx` and the wrapper once:

```bash
command -v npx >/dev/null 2>&1
PLAYWRIGHT_WRAPPER="$PLAYWRIGHT_SKILL_DIR/scripts/playwright_cli.sh"
test -x "$PLAYWRIGHT_WRAPPER"
```

Use one named CLI session per coherent flow. Call `open` once for a new session, then keep work in
as few `run-code` calls as practical:

```bash
PLAYWRIGHT_CLI_SESSION=fast "$PLAYWRIGHT_WRAPPER" open https://example.com
```

A `run-code` callback receives `page` directly, so use `async (page) => { ... }`. Set
`page.setDefaultTimeout(5000)` and `page.setDefaultNavigationTimeout(5000)` at the start of each
callback. Snapshot before using element refs, and refresh refs after navigation or substantial DOM
changes. Wait for each command session to complete; never launch `close`, `open`, and `run-code` in
a loop that discards returned session IDs.
