#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
plugin_dir=$(cd -- "$script_dir/.." && pwd)
playwright_version=$(node -p 'require(process.argv[1]).playwrightVersion' "$plugin_dir/runtime.json")
chromium_revision=$(node -p 'require(process.argv[1]).chromiumRevision' "$plugin_dir/runtime.json")
chromium_version=$(node -p 'require(process.argv[1]).chromiumVersion' "$plugin_dir/runtime.json")
codex_runtime_home=${CODEX_HOME:-${HOME}/.codex}
runtime_dir="$codex_runtime_home/runtimes/playwright-fast/$playwright_version"
node_modules="$runtime_dir/node_modules"
package_file="$node_modules/playwright/package.json"

installed_version=""
if [[ -f "$package_file" ]]; then
  installed_version=$(node -p 'require(process.argv[1]).version' "$package_file" 2>/dev/null || true)
fi

if [[ "$installed_version" != "$playwright_version" || \
  ! -f "$node_modules/playwright/cli.js" || \
  ! -f "$node_modules/playwright-core/browsers.json" ]]; then
  mkdir -p "$runtime_dir"
  npm install \
    --prefix "$runtime_dir" \
    --no-save \
    --no-package-lock \
    --no-audit \
    --no-fund \
    --omit=dev \
    "playwright@$playwright_version"
fi

browser_metadata=$(node - "$node_modules/playwright-core/browsers.json" <<'NODE'
const fs = require("node:fs");
const browsers = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const chromium = browsers.browsers.find((browser) => browser.name === "chromium");
process.stdout.write(`${chromium?.revision || ""}\t${chromium?.browserVersion || ""}`);
NODE
)
IFS=$'\t' read -r actual_revision actual_chromium_version <<<"$browser_metadata"
if [[ "$actual_revision" != "$chromium_revision" || "$actual_chromium_version" != "$chromium_version" ]]; then
  echo "playwright-fast: Playwright $playwright_version declares Chromium $actual_revision ($actual_chromium_version), expected $chromium_revision ($chromium_version)" >&2
  exit 1
fi

if [[ -n "${PLAYWRIGHT_EXECUTABLE_PATH:-}" ]]; then
  if [[ ! -f "$PLAYWRIGHT_EXECUTABLE_PATH" || ! -x "$PLAYWRIGHT_EXECUTABLE_PATH" ]]; then
    echo "playwright-fast: PLAYWRIGHT_EXECUTABLE_PATH is not an executable file: $PLAYWRIGHT_EXECUTABLE_PATH" >&2
    exit 1
  fi
else
  executable_path=$(NODE_PATH="$node_modules${NODE_PATH:+:$NODE_PATH}" \
    node -p 'require("playwright").chromium.executablePath()')
  if [[ -z "$executable_path" || ! -x "$executable_path" ]]; then
    node "$node_modules/playwright/cli.js" install chromium --no-shell
  fi
fi

PLAYWRIGHT_NODE_MODULES="$node_modules" node "$script_dir/resolve-runtime.js"
