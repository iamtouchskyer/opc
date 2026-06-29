#!/usr/bin/env bash
# OPC PostCompact hook — inject resume context after context compaction.
# Outputs additionalContext JSON so the model knows to resume the OPC flow.
#
# Register: opc install-hooks
# Trigger:  Claude Code PostCompact event (manual or auto)
set -euo pipefail

OPC_HARNESS="${OPC_HARNESS:-$HOME/.claude/skills/opc/bin/opc-harness.mjs}"
[ -f "$OPC_HARNESS" ] || exit 0

# Read the PostCompact event payload from stdin (Claude Code provides cwd here).
INPUT="$(cat 2>/dev/null || true)"
CWD="$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null || true)"

# Resume only flows that were touched recently. A flow that has not been
# advanced in this window is treated as abandoned, not "interrupted by
# compaction" — resuming it injects an unrelated stale task. Override with
# OPC_RESUME_MAX_AGE_HOURS (0 disables the age gate).
MAX_AGE_HOURS="${OPC_RESUME_MAX_AGE_HOURS:-12}"

# Find in-progress flows
FLOW_JSON=$(node "$OPC_HARNESS" ls 2>/dev/null) || exit 0

# Select the most recent in-progress flow that (a) belongs to the current
# working directory when known, and (b) is fresh enough to be a real resume.
NOW="$(date +%s)"
LATEST=$(echo "$FLOW_JSON" | jq -r \
  --arg cwd "$CWD" \
  --argjson now "$NOW" \
  --argjson maxage "$MAX_AGE_HOURS" '
  [.flows[]
    | select(.status == "in_progress")
    | select($cwd == "" or .projectRoot == null or .projectRoot == $cwd)
    | select(
        $maxage == 0
        or (($now - (.lastModified | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601)) < ($maxage * 3600))
      )
  ]
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
4. Re-read SKILL.md and the relevant protocol for this node type — do NOT rely on pre-compaction memory"

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

# Output hook JSON — use top-level systemMessage (hookSpecificOutput only supports PreToolUse/PostToolUse/UserPromptSubmit)
cat <<EOF
{
  "systemMessage": $ESCAPED
}
EOF
