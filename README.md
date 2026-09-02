# JCB Codex Plugins

Public Codex marketplace and skill source repository for reusable development tooling.

## Layout

- `.agents/plugins/marketplace.json`: Codex marketplace metadata.
- `plugins/playwright-fast`: Codex plugin that exposes the persistent Playwright MCP server.
- `plugins/playwright-fast/skills`: Skills bundled with the Playwright Fast plugin.
- `skills`: Standalone skill sources that can be linked into `~/.codex/skills`.

## Install

Prerequisites:

- `codex` CLI
- `python3`
- Git access to `github.com/jiangchunbo/jcb-codex-plugins`

Clone this repository and run:

```bash
./install.sh
```

Then start a new Codex task. The installation provides:

- `playwright-fast`: persistent Playwright MCP with scoped locators, popup and frame flows, response capture, credential-aware CORS mocks, request-failure diagnostics, storage fixtures, and compact evidence
- `playwright`: MCP-first real-browser workflow with on-demand JSONL, repository-runner, REPL, and CLI fallbacks
- standalone JCB skills from `skills/*`, linked into `~/.codex/skills` when the destination is absent or already a symlink

## Update

Run `./install.sh` again. It refreshes the marketplace snapshot and reinstalls the current plugin version.

The repository marketplace is declared in `.agents/plugins/marketplace.json`; plugin sources are under `plugins/`, and standalone skill sources are under `skills/`.
