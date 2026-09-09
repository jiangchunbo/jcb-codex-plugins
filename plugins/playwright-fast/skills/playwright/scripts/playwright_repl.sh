#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
plugin_dir=$(cd -- "$script_dir/../../.." && pwd)
runtime_script=${1:-"$script_dir/playwright_repl.js"}

if [[ ! -f "$runtime_script" ]]; then
  echo "Playwright runtime script not found: $runtime_script" >&2
  exit 1
fi

if ! runtime_line=$(node "$plugin_dir/scripts/resolve-runtime.js" --lines); then
  exit 1
fi
IFS=$'\t' read -r node_modules playwright_version chromium_revision chromium_version browser_executable browser_source <<<"$runtime_line"

exec env \
  NODE_PATH="$node_modules${NODE_PATH:+:$NODE_PATH}" \
  PLAYWRIGHT_FAST_PLAYWRIGHT_VERSION="$playwright_version" \
  PLAYWRIGHT_FAST_CHROMIUM_REVISION="$chromium_revision" \
  PLAYWRIGHT_FAST_CHROMIUM_VERSION="$chromium_version" \
  PLAYWRIGHT_FAST_BROWSER_EXECUTABLE_PATH="$browser_executable" \
  PLAYWRIGHT_FAST_BROWSER_SOURCE="$browser_source" \
  node --experimental-repl-await "$runtime_script"
