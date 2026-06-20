# Tier Coverage Schema

`tierCoverage` is required on completed `execute` node handshakes when
`.harness/flow-state.json` has a quality tier with warning or critical baseline
items. It is the executor's explicit proof that every tier baseline item was
tested or consciously skipped.

Functional tier has no required keys. Polished and delightful tiers are enforced
by `opc-harness validate`.

## Shape

```json
{
  "tierCoverage": {
    "covered": ["typography", "color-scheme", "navigation"],
    "skipped": [
      {
        "key": "code-blocks",
        "reason": "Product has no code examples or developer documentation surfaces."
      }
    ]
  }
}
```

Rules:

- `covered` must be an array of baseline key strings.
- `skipped` must be an array of `{ "key": string, "reason": string }` objects.
- `reason` must be at least 10 characters and explain why the item is not applicable.
- Every required key for the tier must appear in either `covered` or `skipped`.
- Unknown keys are rejected.

## Baseline Keys

### `polished`

Required keys:

```text
typography
color-scheme
navigation
responsive
code-blocks
tables
testing-md
loading-states
error-states
favicon-meta
focus-styles
```

Valid but optional at this tier:

```text
page-transitions
```

### `delightful`

Required keys:

```text
typography
color-scheme
navigation
responsive
code-blocks
tables
testing-md
loading-states
error-states
favicon-meta
focus-styles
page-transitions
micro-interactions
```

There are no optional baseline keys at this tier.

## Validation

Run:

```bash
opc-harness validate .harness/nodes/test-execute/handshake.json
```

On malformed `tierCoverage`, the error includes this schema path plus the valid
and required key lists for the active tier.

To see executable tier test cases:

```bash
opc-harness tier-baseline --tier polished
opc-harness tier-baseline --tier delightful
```
