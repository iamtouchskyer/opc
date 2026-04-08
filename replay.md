---
name: opc-replay
description: "Browse past OPC runs. Opens HTML viewer for flow replay or report. Usage: /opc replay [list|flow]"
---

# OPC Replay

Browse past `/opc` runs — flow replay animation or structured report viewer.

## Usage

- `/opc replay` — Open flow replay if `.harness/` exists, otherwise open latest report
- `/opc replay flow` — Open flow replay for current `.harness/` directory
- `/opc replay list` — List all saved reports
- `/opc replay report` — Open latest report in viewer

## Steps

### If "list" argument:

1. Run: `ls -la ~/.opc/reports/*.json 2>/dev/null | tail -20`
2. If no reports: "No reports yet. Run `/opc review` first." → stop.
3. Parse filenames and present a table:

```
| # | Date | Mode | Task | Size |
|---|------|------|------|------|
| 1 | 2026-03-27 10:30 | review | PR authentication fix | 2.1kb |
```

4. Ask: "Which report? (number or 'latest')"

### If "flow" argument (or default with .harness/ present):

1. Check if `.harness/flow-state.json` exists in current directory.
2. If not found: "No flow state found in `.harness/`. Run `/opc <task>` first." → stop.
3. Print one-line summary from flow-state.json:
   ```
   🎬 Flow: {template} — {totalSteps} transitions — entry: {entryNode} → current: {currentNode}
   ```

4. Open HTML flow replay viewer:
   ```
   🖥️ Opening Flow Replay...
   ```
   ```bash
   npx @touchskyer/opc-viewer --flow=.harness
   ```
   This will:
   - Start the viewer server on :5177 (or reuse existing)
   - Open browser to `?flow=.harness` which shows the animated flow graph
   - Playback controls: ▶ Play, ⏸ Pause, ◀/▶▶ step, scrubber, keyboard (Space/→/←/P/R)

5. If npx fails, show install instructions:
   ```
   ⚠️ Could not launch viewer.
   npm install -g @touchskyer/opc-viewer
   opc-viewer --flow=.harness
   ```

### If "report" argument (or default without .harness/):

1. Find most recent report: `ls -t ~/.opc/reports/*.json 2>/dev/null | head -1`
2. If none found: "No OPC reports found. Run `/opc review` or `/opc analyze` first." → stop.
3. Read the JSON file. Print a one-line summary:
   ```
   📊 {mode} — {task} — {critical} 🔴 {warning} 🟡 {suggestion} 🔵
   ```

4. Open viewer:
   ```
   🖥️ Opening OPC Viewer...
   ```
   ```bash
   npx @touchskyer/opc-viewer --report=<filepath>
   ```

5. If npx fails, fall back to terminal display:

   ```
   📊 OPC Report — {mode} — {timestamp}
   Task: {task}
   Agents: {role1}, {role2}, {role3}

   🔴 Critical ({count})
     {file}:{line} — {issue}
     → {fix}

   🟡 Warning ({count})
     {file}:{line} — {issue}
     → {fix}

   🔵 Suggestion ({count})
     {file}:{line} — {issue}
     → {fix}

   Coordinator: {challenged} challenged, {dismissed} dismissed, {downgraded} downgraded
   ```
