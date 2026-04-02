# Handoff Template

The orchestrator writes this file after all tasks in a wave complete. The evaluator's entire understanding of what was built comes from this file, so be thorough and accurate.

Write to `.harness/handoff-wave-N.md` using this structure:

```markdown
# Wave {N} Handoff

## What Was Built

{For each task completed in this wave, 2-3 sentences describing what was implemented and where the key files are.}

### Task 1: {task name}
- {What it does}
- {Key files: paths to the main files created or changed}

### Task 2: {task name}
- ...

## How to Run

{Exact commands to start the application. Be specific — include port numbers, environment setup, any prerequisites.}

```bash
# Example:
cd {project directory}
npm install
npm run dev
# App runs at http://localhost:3000
```

## Acceptance Criteria for This Wave

{Copy the acceptance criteria from the plan verbatim. The evaluator grades against these exact criteria.}

- [ ] {criterion 1}
- [ ] {criterion 2}
- [ ] {criterion 3}

## Known Issues

{Be honest. If something is hacky, incomplete, or fragile, say so. The evaluator will find it anyway, and listing it here saves a round-trip.}

- {issue description, or "None" if clean}

## Intentionally Deferred

{List anything that was considered but deliberately left out of this wave — and why. This prevents the evaluator from FAILing work that was scoped out on purpose.}

- {deferred item and reason, or "Nothing deferred" if everything in the plan was implemented}

## Dependencies on Previous Waves

{What from previous waves does this wave build on? Or "First wave — no dependencies."}
```

**Note:** The evaluator has no memory of the build process — this file is its only source of truth. Be thorough or expect false FAILs.
