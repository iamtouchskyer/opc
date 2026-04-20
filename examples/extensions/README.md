# OPC Extensions — Starter

This directory used to host 6 reference extensions. Per the original
extension-system design spec (§1: *"Extensions live in the user's home
directory, never in OPC source"*), the real extensions now live in a
private repo and install into `~/.opc/extensions/`.

## What remains here

- [`_starter/`](./_starter/) — the canonical scaffold for authoring a
  new extension. Copy to `~/.opc/extensions/<your-ext>/` and edit.

## Where the real extensions live

Everything else (design-lint, visual-eval, memex-recall,
git-changeset-review, session-logex, lint-prompt-length) migrated out of
this repo in OPC v0.8.x. They live alongside their paired skills in a
private repo:

```
git clone git@github.com:iamtouchskyer/opc-extensions.git ~/Code/opc-extensions
cd ~/Code/opc-extensions
./install.sh
```

If you're an open-source user of OPC and don't have that repo, OPC
still works — extensions are strictly optional. The core harness has no
dependency on any extension; activation is pure capability-contract
intersection (see `docs/specs/2026-04-16-opc-extension-system-design.md`).

## Authoring your own

1. `cp -R examples/extensions/_starter ~/.opc/extensions/my-ext`
2. Edit `hook.mjs` — declare `meta.provides`, implement whichever hooks
   you need (`promptAppend`, `verdictAppend`, `executeRun`,
   `artifactEmit`).
3. Verify:
   ```bash
   opc-harness extension-test --ext ~/.opc/extensions/my-ext --lint-strict
   opc-harness extension-test --ext ~/.opc/extensions/my-ext --all-hooks \
     --context '{"nodeCapabilities":["your-capability@1"]}'
   ```
4. Done — OPC picks it up on next flow run, gated by capability match.

## Historical

- `docs/history/run3-findings-for-run5.md` — the 7 Run-3 findings
  (F1–F7) that drove the Run-5 polish wave.
