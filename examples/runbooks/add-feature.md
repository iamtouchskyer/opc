---
version: 1
id: add-feature
title: Add a Feature
tags:
  - build
  - frontend
match:
  - add feature
  - new feature
  - implement feature
  - add a feature
  - "/^implement /i"
  - "/\badd\s+(a|an|the)\s+\w+/i"
flow: build-verify
tier: polished
units:
  - spec
  - plan
  - build
  - review
  - fix
  - test-design
  - test-execute
  - acceptance
  - e2e
protocolRefs:
  - implementer-prompt.md
  - role-evaluator-prompt.md
  - test-design-protocol.md
  - executor-protocol.md
createdAt: 2026-04-19
updatedAt: 2026-04-19
---
# Add Feature — Reference Runbook

The canonical recipe for "add a feature to an existing codebase." Ship
this in `.opc/runbooks/` (or `~/.opc/runbooks/`) and any `/opc loop`
whose task phrase contains `add feature` / `new feature` /
`implement feature` (or starts with `implement`) will use this unit
structure instead of decomposing from scratch.

## Why these units

The separation is not cosmetic — each unit enforces the OPC prime
directive: **the agent that does the work never evaluates it.**

- **spec** — pin acceptance criteria before any code. Tier is
  `polished` (UI work), so baseline items (dark/light, responsive,
  loading/error/empty, focus styles) are mandatory.
- **plan** — decompose the feature into concrete DoD bullets.
  Verify/eval lines per sub-task written to `.harness/plan.md`.
- **build** — implementer subagent writes the code.
- **review** — ≥2 independent reviewers (typically frontend +
  backend, or frontend + a11y for pure UI). Dispatched via Agent
  tool, never self-review.
- **fix** — address 🔴 + 🟡 findings from review. A separate tick so
  the fix is a standalone commit and git bisect stays useful.
- **test-design** — a different subagent designs test cases without
  running them (API tests, E2E UI scenarios, edge cases, a11y).
- **test-execute** — orchestrator runs the designed plan and captures
  evidence (test output, screenshots, a11y scan results).
- **acceptance** — PM/designer sign-off against the spec's DoD.
- **e2e** — new-user + active-user personas walk the full flow.

## When to deviate

- **Simple UI tweak** → drop `spec` + `e2e`, keep
  `plan/build/review/fix/test-execute`.
- **Pure backend feature** → drop `e2e` (executor-protocol handles
  API verify via test-execute), keep the rest.
- **Complex subsystem** → insert a `design` unit between `spec` and
  `plan` to brainstorm architecture.

Override this runbook at invocation time by setting
`OPC_DISABLE_RUNBOOKS=1` before the harness call (forces match-miss
without scanning disk). To use a project-local variant, copy this file
to your project (or any directory) and point `OPC_RUNBOOKS_DIR` at it
— the CLI resolves `--dir` flag → `OPC_RUNBOOKS_DIR` env var →
`~/.opc/runbooks/` (default), in that order. There is no automatic
project-local `.opc/runbooks/` discovery today.

## Match patterns

The `match:` list is case-insensitive whole-word:

- `add feature` — scores 20 (2 words × 10)
- `new feature` — scores 20
- `implement feature` — scores 20
- `add a feature` — scores 30 (3 words × 10) — wins against the
  2-word phrases when the task is verbose
- `/^implement /i` — regex for "implement anything" (scores 5). Lower
  than keyword matches so a more specific phrase wins if both fire.

Tags `build` and `frontend` contribute +3 each if they appear as
whole words in the task (e.g., "add a new build step" would pick up
the `build` tag).

## Acceptance criteria (baseline subset)

A representative subset derived from the `polished` tier. The full
checklist (typography, navigation, code blocks, tables, favicon,
smooth-scroll, etc.) lives in `pipeline/quality-tiers.md` — when this
runbook fires, the orchestrator's quality-tier expansion picks up
*all* polished items, not just the ones below. The bullets here are
illustrative of what an `add a dark-mode toggle` task would surface
first.

- [ ] Dark + light theme pass visual review
- [ ] Responsive at 375 / 768 / 1280 widths (extend to 320/1024/1440 per
      tier baseline)
- [ ] Loading / error / empty states covered
- [ ] Focus styles on every interactive element
- [ ] No console errors / warnings
- [ ] a11y: axe-core clean (no critical/serious violations)
