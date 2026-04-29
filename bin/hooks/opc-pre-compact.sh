#!/usr/bin/env bash
# OPC PreCompact hook — snapshot active flow state before context compaction.
# Writes a resume brief so PostCompact can inject it into the new context.
#
# Register: opc install-hooks
# Trigger:  Claude Code PreCompact event (manual or auto)
set -euo pipefail

OPC_HARNESS="${OPC_HARNESS:-$HOME/.claude/skills/opc/bin/opc-harness.mjs}"
[ -f "$OPC_HARNESS" ] || exit 0

# Find in-progress flows
FLOW_JSON=$(node "$OPC_HARNESS" ls 2>/dev/null) || exit 0

# Pick the latest in-progress flow by lastModified
LATEST=$(echo "$FLOW_JSON" | jq -r '
  [.flows[] | select(.status == "in_progress")]
  | sort_by(.lastModified) | last // empty
  | @json
' 2>/dev/null)

[ -z "$LATEST" ] || [ "$LATEST" = "null" ] && exit 0

DIR=$(echo "$LATEST" | jq -r '.dir')
FLOW=$(echo "$LATEST" | jq -r '.flow')
NODE=$(echo "$LATEST" | jq -r '.currentNode')
STEPS=$(echo "$LATEST" | jq -r '.totalSteps')

[ -d "$DIR" ] || exit 0

# Check for acceptance criteria
AC_FILE="$DIR/acceptance-criteria.md"
AC_NOTE=""
if [ -f "$AC_FILE" ]; then
  AC_NOTE="- **Acceptance criteria**: $AC_FILE"
fi

# Write resume brief
cat > "$DIR/resume-brief.md" <<EOF
# OPC Resume Brief

- **Session dir**: $DIR
- **Flow**: $FLOW
- **Current node**: $NODE
- **Steps completed**: $STEPS
- **Snapshot time**: $(date -u +%Y-%m-%dT%H:%M:%SZ)
$AC_NOTE

## Resume instructions
1. Run \`opc-harness ls\` to confirm flow state
2. Re-read \`$DIR/acceptance-criteria.md\`
3. Continue executing node **$NODE** in the **$FLOW** flow
4. Follow the standard OPC protocol for this node type
EOF

exit 0
