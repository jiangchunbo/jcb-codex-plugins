# JCB Codex Plugins

Private Codex marketplace for reusable development tooling.

## Install

Prerequisites:

- `codex` CLI
- `python3`
- GitHub SSH access for `jiangchunbo/jcb-codex-plugins`

Clone this repository and run:

```bash
./install.sh
```

Then start a new Codex task. The installation provides:

- `playwright-fast`: persistent Playwright MCP with request-aware mocks, storage fixtures, geometry checks, and compact evidence
- `playwright`: real-browser workflow and CLI fallback
- `playwright-efficient`: persistent JSONL driver and speed-first evidence policy

## Update

Run `./install.sh` again. It refreshes the marketplace snapshot and reinstalls the current plugin version.

The repository marketplace is declared in `.agents/plugins/marketplace.json`; the plugin source is under `plugins/playwright-fast`.
