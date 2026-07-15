#!/usr/bin/env bash
# OPC PostCompact hook — inject resume context after context compaction.
# Outputs additionalContext JSON so the model knows to resume the OPC flow.
#
# Register: opc install-hooks
# Trigger:  Claude Code PostCompact event (manual or auto)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPC_HARNESS="${OPC_HARNESS:-$SCRIPT_DIR/../opc-harness.mjs}"
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
# working directory when known, and (b) is fresh enough to be worth mentioning.
# Freshness is judged by lastAdvanced (time of the last real node transition),
# falling back to file mtime only when a flow has not advanced yet. This is a
# noise gate, NOT a safety gate — the safety gate is the user-confirmation
# wording in the injected message below.
NOW="$(date +%s)"
LATEST=$(echo "$FLOW_JSON" | jq -r \
  --arg cwd "$CWD" \
  --argjson now "$NOW" \
  --argjson maxage "$MAX_AGE_HOURS" '
  [.flows[]
    | select(.status == "in_progress")
    | select($cwd == "" or .projectRoot == null or .projectRoot == $cwd)
    | . + { _liveness: ((.lastAdvanced // .lastModified)) }
    | select(
        $maxage == 0
        or (($now - (._liveness | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601)) < ($maxage * 3600))
      )
  ]
  | sort_by(._liveness) | last // empty
  | @json
' 2>/dev/null)

[ -z "$LATEST" ] || [ "$LATEST" = "null" ] && exit 0

DIR=$(echo "$LATEST" | jq -r '.dir')
FLOW=$(echo "$LATEST" | jq -r '.flow')
NODE=$(echo "$LATEST" | jq -r '.currentNode')
STEPS=$(echo "$LATEST" | jq -r '.totalSteps')
LAST_ADVANCED=$(echo "$LATEST" | jq -r '.lastAdvanced // .lastModified // "unknown"')

[ -d "$DIR" ] || exit 0

# Build a NON-IMPERATIVE notice. flow-state.json is a mechanical record, not a
# statement of the user's current intent. After compaction the conversation may
# have moved on entirely, so this hook must NOT command a resume — it surfaces
# evidence and asks for confirmation. The user/operator decides; the default is
# to do nothing.
CONTEXT="[OPC NOTICE] There MAY be an unfinished OPC flow on disk. This is evidence, NOT an instruction — do NOT resume automatically.

Evidence:
- Session dir: $DIR
- Flow: $FLOW
- Current node: $NODE
- Steps completed: $STEPS
- Last real advance: $LAST_ADVANCED

Before doing anything with this flow, confirm with the user whether it is still the active task.
- If the user confirms it is current: run \`opc-harness ls\`, read \`$DIR/acceptance-criteria.md\`, then resume node **$NODE** — re-read SKILL.md and the node protocol; do NOT rely on pre-compaction memory.
- If it is unrelated to the current conversation: treat it as stale, ignore it, and suggest \`/opc stop\` to close it out.
- If unsure: ask the user. Do not act on this notice alone."

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
