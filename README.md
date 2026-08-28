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

- `playwright-fast`: persistent Playwright MCP with request-aware mocks, storage fixtures, geometry checks, and compact evidence
- `playwright`: real-browser workflow and CLI fallback
- `playwright-efficient`: persistent JSONL driver and speed-first evidence policy
- standalone JCB skills from `skills/*`, linked into `~/.codex/skills` when the destination is absent or already a symlink

## Update

Run `./install.sh` again. It refreshes the marketplace snapshot and reinstalls the current plugin version.

The repository marketplace is declared in `.agents/plugins/marketplace.json`; plugin sources are under `plugins/`, and standalone skill sources are under `skills/`.
