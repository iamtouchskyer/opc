#!/usr/bin/env bash
# OPC PostCompact hook — inject resume context after context compaction.
# Outputs additionalContext JSON so the model knows to resume the OPC flow.
#
# Register: opc install-hooks
# Trigger:  Claude Code PostCompact event (manual or auto)
set -euo pipefail

OPC_HARNESS="${OPC_HARNESS:-$HOME/.claude/skills/opc/bin/opc-harness.mjs}"
[ -f "$OPC_HARNESS" ] || exit 0

# Find in-progress flows
FLOW_JSON=$(node "$OPC_HARNESS" ls 2>/dev/null) || exit 0

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

# Build resume context message
CONTEXT="[OPC RESUME] You have an in-progress OPC flow that was interrupted by context compaction.

- Session dir: $DIR
- Flow: $FLOW
- Current node: $NODE
- Steps completed: $STEPS

Action required:
1. Run \`opc-harness ls\` to confirm flow state
2. Read \`$DIR/acceptance-criteria.md\` for the definition of done
3. Resume executing node **$NODE** in the **$FLOW** flow
4. Re-read skill.md and the relevant protocol for this node type — do NOT rely on pre-compaction memory"

# If resume-brief.md exists (written by PreCompact), append it
BRIEF="$DIR/resume-brief.md"
if [ -f "$BRIEF" ]; then
  BRIEF_CONTENT=$(cat "$BRIEF")
  CONTEXT="$CONTEXT

--- Resume Brief ---
$BRIEF_CONTENT"
fi

# Escape for JSON
ESCAPED=$(echo "$CONTEXT" | jq -Rs .)

# Output hook JSON
cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PostCompact",
    "additionalContext": $ESCAPED
  }
}
EOF
