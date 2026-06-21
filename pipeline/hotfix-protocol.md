# Hotfix Protocol

`hotfix` is the narrow repair node between `test-execute` and the terminal
gate. It exists so a one-line repair does not force a full build-review-test
loop, while preserving the rule that `test-execute` only runs tests and gathers
evidence.

## Allowed Scope

Allowed:

- Add or correct an accessibility attribute.
- Adjust a color token or contrast value.
- Fix a typo, label, heading level, or ARIA relationship.
- Repair a missing class or obvious selector mismatch.
- Make a small config/test-command correction needed to rerun evidence.

Forbidden:

- New feature behavior.
- Data model, API, persistence, routing, or auth changes.
- Large component rewrites.
- Test expectation changes that hide a product failure.
- Any change that needs a new design or architecture decision.

## Flow Rule

`test-execute` uses:

- `PASS -> gate`
- `ITERATE -> hotfix`

`hotfix` uses:

- `PASS -> test-execute`
- `ITERATE -> build`
- `FAIL -> brief`

After a hotfix, evidence must be recaptured by `test-execute`; hotfix output is
not final verification.

## Handshake

A completed hotfix node must write a normal handshake with `nodeType:"hotfix"`
and a structured `hotfix` object:

```json
{
  "nodeId": "hotfix",
  "nodeType": "hotfix",
  "runId": "run_1",
  "status": "completed",
  "verdict": "PASS",
  "summary": "Adjusted focus contrast token and aria-label.",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "artifacts": [{ "type": "hotfix-report", "path": "run_1/hotfix-report.md" }],
  "hotfix": {
    "scope": "trivial",
    "allowedOperations": ["contrast-token-adjustment", "aria-label"],
    "forbiddenOperations": [],
    "structuralChange": false
  }
}
```

`opc-harness validate` rejects hotfix handshakes that omit the `hotfix` object,
claim a non-trivial scope, mark `structuralChange:true`, or list forbidden
operations.
