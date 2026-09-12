# JCB Codex Plugins

Public Codex marketplace and skill source repository for reusable development tooling.

## Layout

- `.agents/plugins/marketplace.json`: Codex marketplace metadata.
- `plugins/playwright-fast`: Codex plugin that exposes the persistent Playwright MCP server.
- `plugins/playwright-fast/skills`: Skills bundled with the Playwright Fast plugin.
- `plugins/playwright-fast/evals`: model/effort and browser-routing evaluations, with deterministic fixtures and optional real-page checks.
- `skills`: Standalone skill sources that can be linked into `~/.codex/skills`.

## Install

Prerequisites:

- `codex` CLI
- Node.js and npm
- `python3`
- Git access to `github.com/jiangchunbo/jcb-codex-plugins`

Clone this repository and run:

```bash
./install.sh
```

Then start a new Codex task. The installation provides:

- `playwright-fast`: persistent Playwright MCP with visible nested contracts, forgiving common action syntax, SPA-aware navigation, scoped locators, response capture, and compact evidence
- a pinned Playwright and Chromium runtime under `~/.codex/runtimes/playwright-fast/`, installed before the plugin is updated
- `playwright`: MCP-first real-browser workflow with on-demand JSONL, repository-runner, REPL, and CLI fallbacks
- standalone JCB skills from `skills/*`, linked into `~/.codex/skills` when the destination is absent or already a symlink

## Update

Run `./install.sh` again. It refreshes the marketplace snapshot and reinstalls the current plugin version.

The installer reuses a matching browser runtime and does not download it again. To use a system
browser explicitly, set `PLAYWRIGHT_EXECUTABLE_PATH` to an executable Chrome or Chromium path;
the Playwright library version remains pinned.

The repository marketplace is declared in `.agents/plugins/marketplace.json`; plugin sources are under `plugins/`, and standalone skill sources are under `skills/`.

## Playwright Fast 1.2.0

This release adds local adaptive routing using inherited HTTP/HTTPS proxy settings, WS/WSS-aware
Chromium PAC routing, and context-owned HTTP connection pools. Without a supported inherited proxy,
browser traffic stays direct and no relay or probes start. Delayed connection competition remains
experimental and off by default. Neither system proxy nor model API routing is changed.

The bundled skill also incorporates the retained GPT-5.5/Luna speed evaluations, preferring Luna
low for eligible routine delegated browser work and medium for complex multi-stage flows.
See the [release notes](plugins/playwright-fast/CHANGELOG.md),
[routing guide](plugins/playwright-fast/skills/playwright/references/routing.md), and
[verification results](plugins/playwright-fast/evals/ROUTING-FIXES.md).
