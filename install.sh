#!/usr/bin/env bash
set -euo pipefail

marketplace_name="jcb-codex-plugins"
marketplace_source="git@github.com:jiangchunbo/jcb-codex-plugins.git"

if codex plugin marketplace list --json | python3 -c '
import json
import sys

target = sys.argv[1]
data = json.load(sys.stdin)
raise SystemExit(0 if any(item.get("name") == target for item in data.get("marketplaces", [])) else 1)
' "$marketplace_name"; then
  codex plugin marketplace upgrade "$marketplace_name"
else
  codex plugin marketplace add "$marketplace_source" --ref main
fi

codex plugin add "playwright-fast@$marketplace_name"

echo "Installed playwright-fast. Start a new Codex task to load its skills and MCP tools."
