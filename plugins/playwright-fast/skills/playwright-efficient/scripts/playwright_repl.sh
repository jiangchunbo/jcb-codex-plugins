#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
runtime_script=${1:-"$script_dir/playwright_repl.js"}

if [[ ! -f "$runtime_script" ]]; then
  echo "Playwright runtime script not found: $runtime_script" >&2
  exit 1
fi

package_file=$(node -p 'require.resolve("playwright/package.json")' 2>/dev/null || true)

if [[ -z "$package_file" ]]; then
  global_node_modules=$(npm root --global)
  if [[ -f "$global_node_modules/playwright/package.json" ]]; then
    package_file="$global_node_modules/playwright/package.json"
  fi
fi

if [[ -z "$package_file" ]]; then
  npm_cache=${npm_config_cache:-}
  if [[ -z "$npm_cache" ]]; then
    npm_cache=$(npm config get cache)
  fi

  if [[ -d "$npm_cache/_npx" ]]; then
    package_file=$(
      find "$npm_cache/_npx" -path '*/node_modules/playwright/package.json' -type f -printf '%T@ %p\n' \
        | sort -nr \
        | sed -n '1p' \
        | cut -d' ' -f2-
    )
  fi
fi

if [[ -z "$package_file" ]]; then
  echo "No existing Playwright package was found; use the playwright skill wrapper." >&2
  exit 1
fi

node_modules=${package_file%/playwright/package.json}
exec env NODE_PATH="$node_modules${NODE_PATH:+:$NODE_PATH}" \
  node --experimental-repl-await "$runtime_script"
