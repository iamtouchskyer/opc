---
name: opc-replay
description: "Browse past OPC reports. Opens web viewer via npx, falls back to terminal. Usage: /opc replay [list]"
---

# OPC Replay

Browse structured reports from past `/opc` runs.

## Usage

- `/opc replay` — Open the most recent report
- `/opc replay list` — List all saved reports

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

### Default (no argument):

1. Find most recent report: `ls -t ~/.opc/reports/*.json 2>/dev/null | head -1`
2. If none found: "No OPC reports found. Run `/opc review` or `/opc analyze` first." → stop.
3. Read the JSON file. Print a one-line summary:
   ```
   📊 {mode} — {task} — {critical} 🔴 {warning} 🟡 {suggestion} 🔵
   ```

4. Tell the user what's about to happen, then open viewer:
   ```
   🖥️ Opening OPC Viewer...
   Running: npx @touchskyer/opc-viewer --report=<filepath>
   (First run may take a moment to download the viewer package)
   ```
   ```bash
   npx @touchskyer/opc-viewer --report=<filepath>
   ```
   This will:
   - If viewer is already running on :5177 → just open browser to the existing instance
   - If not running → start server + open browser
   - Zero install needed — npx handles everything

5. If npx fails (no network, npm down, permission error), show install instructions AND fall back to terminal:

   ```
   ⚠️ Could not launch OPC Viewer automatically.

   To install manually:
     npm install -g @touchskyer/opc-viewer
     opc-viewer --report=<filepath>

   Or run without installing:
     npx @touchskyer/opc-viewer --report=<filepath>

   Falling back to terminal view...
   ```

   Then show the terminal report:

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
