#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ -t 0 ]]; then
  stty -echo
fi
exec "$script_dir/playwright_repl.sh" "$script_dir/playwright_driver.js"
