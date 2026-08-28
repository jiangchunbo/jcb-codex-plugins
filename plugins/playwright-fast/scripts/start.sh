#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
plugin_dir=$(cd -- "$script_dir/.." && pwd)
package_file=""

if [[ -n "${PLAYWRIGHT_NODE_MODULES:-}" ]] &&
  [[ -f "${PLAYWRIGHT_NODE_MODULES}/playwright/package.json" ]]; then
  package_file="${PLAYWRIGHT_NODE_MODULES}/playwright/package.json"
fi

if [[ -z "$package_file" ]]; then
  package_file=$(node -p 'require.resolve("playwright/package.json")' 2>/dev/null || true)
fi

if [[ -z "$package_file" ]]; then
  node_binary=$(readlink -f "$(command -v node)")
  global_node_modules="$(dirname "$(dirname "$node_binary")")/lib/node_modules"
  if [[ -f "$global_node_modules/playwright/package.json" ]]; then
    package_file="$global_node_modules/playwright/package.json"
  fi
fi

if [[ -z "$package_file" ]]; then
  npm_cache=${npm_config_cache:-${HOME}/.npm}

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
  echo "playwright-fast: no existing Playwright package found" >&2
  exit 1
fi

node_modules=${package_file%/playwright/package.json}
exec env NODE_PATH="$node_modules${NODE_PATH:+:$NODE_PATH}" node "$plugin_dir/scripts/server.js"
