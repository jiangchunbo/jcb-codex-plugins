#!/usr/bin/env bash
set -euo pipefail

marketplace_name="jcb-codex-plugins"
marketplace_source="https://github.com/jiangchunbo/jcb-codex-plugins.git"
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
codex_home="${CODEX_HOME:-${HOME}/.codex}"
skills_dir="${codex_home}/skills"

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

mkdir -p "$skills_dir"

if [[ -d "$repo_dir/skills" ]]; then
  for skill_path in "$repo_dir"/skills/*; do
    [[ -d "$skill_path" ]] || continue
    skill_name=$(basename "$skill_path")
    target="$skills_dir/$skill_name"

    if [[ -L "$target" || ! -e "$target" ]]; then
      ln -sfn "$skill_path" "$target"
      echo "Linked skill: $skill_name"
    else
      echo "Skipped skill with existing non-symlink target: $target" >&2
    fi
  done
fi

echo "Installed playwright-fast and linked available standalone skills. Start a new Codex task to load updated skills and MCP tools."
