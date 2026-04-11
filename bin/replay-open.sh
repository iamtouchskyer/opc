#!/usr/bin/env bash
# replay-open.sh — Generate replay data and open the HTML viewer in browser
# Usage: replay-open.sh [.harness-dir]

set -euo pipefail

HARNESS_DIR="${1:-.harness}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HARNESS_BIN="$SCRIPT_DIR/opc-harness.mjs"
VIEWER_HTML="$SCRIPT_DIR/replay-viewer.html"

# Validate inputs exist
if [ ! -f "$HARNESS_BIN" ]; then
  echo "Error: opc-harness.mjs not found at $HARNESS_BIN" >&2
  exit 1
fi

if [ ! -f "$VIEWER_HTML" ]; then
  echo "Error: replay-viewer.html not found at $VIEWER_HTML" >&2
  exit 1
fi

if [ ! -d "$HARNESS_DIR" ]; then
  echo "Error: harness directory '$HARNESS_DIR' not found" >&2
  exit 1
fi

if [ ! -f "$HARNESS_DIR/flow-state.json" ]; then
  echo "Error: no flow-state.json in '$HARNESS_DIR'" >&2
  exit 1
fi

# Generate replay JSON
REPLAY_JSON=$(node "$HARNESS_BIN" replay --dir "$HARNESS_DIR" 2>/dev/null)
if [ -z "$REPLAY_JSON" ]; then
  echo "Error: opc-harness replay produced no output" >&2
  exit 1
fi

# Create temp HTML file
TMPFILE=$(mktemp /tmp/opc-replay-XXXXXX.html)
trap 'rm -f "$TMPFILE"' EXIT

# Write the data script + viewer into the temp file
{
  echo '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>'
  echo '<script>'
  echo "window.REPLAY_DATA = $REPLAY_JSON;"
  echo '</script>'
  # Inline the full viewer HTML (extract everything between <style> and </html>)
  # Simpler: just cat the whole viewer — the browser will handle the nested doctype gracefully
  cat "$VIEWER_HTML"
  echo '</body></html>'
} > "$TMPFILE"

echo "Replay viewer: $TMPFILE"

# Open in default browser
if command -v open &>/dev/null; then
  open "$TMPFILE"
  # Keep file alive briefly so browser can load it
  sleep 2
elif command -v xdg-open &>/dev/null; then
  xdg-open "$TMPFILE" &
  sleep 2
elif command -v wslview &>/dev/null; then
  wslview "$TMPFILE" &
  sleep 2
else
  echo "Open this file in your browser: $TMPFILE"
  # Don't clean up if we can't auto-open
  trap - EXIT
fi
