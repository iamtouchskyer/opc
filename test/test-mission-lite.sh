#!/usr/bin/env bash
set -euo pipefail
exec node --test "$(dirname "$0")/mission-lite.test.mjs"
