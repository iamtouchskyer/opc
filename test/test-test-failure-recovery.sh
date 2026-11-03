#!/bin/bash
set -e
source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir
setup_git
write_golden_brief brief.md
write_complete_test_plan test-plan.md

node --input-type=module - "$OPC_HARNESS_BIN" <<'JS'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const harness = process.argv[2];
for (const flow of ['build-verify', 'full-stack']) {
  const dir = resolve(flow);
  const cli = (...args) => {
    const output = execFileSync(process.execPath, [harness, ...args, '--dir', dir, '--flow', flow],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    try { return JSON.parse(output); }
    catch { return JSON.parse(output.trim().split('\n').at(-1)); }
  };
  const state = () => JSON.parse(readFileSync(`${dir}/flow-state.json`, 'utf8'));
  const handshake = (node, nodeType, files = {}, extra = {}) => {
    const runId = state().history.at(-1)?.runId || 'run_1';
    const runDir = `${dir}/nodes/${node}/${runId}`;
    mkdirSync(runDir, { recursive: true });
    const artifacts = Object.entries(files).map(([path, [type, content]]) => {
      writeFileSync(`${runDir}/${path}`, content);
      return { type, path };
    });
    const data = { nodeId: node, nodeType, runId, status: 'completed', verdict: 'PASS',
      summary: 'Recovery integration fixture', timestamp: new Date().toISOString(), artifacts, ...extra };
    writeFileSync(`${runDir}/handshake.json`, JSON.stringify(data));
    writeFileSync(`${dir}/nodes/${node}/handshake.json`, JSON.stringify({ ...data,
      artifacts: artifacts.map(a => ({ ...a, path: `${runId}/${a.path}` })) }));
  };
  // Synthetic review artifacts exercise the real gate without invoking agents.
  const reviewFiles = Object.fromEntries(['a', 'skeptic-owner'].map(role => [`eval-${role}.md`, ['eval',
    `# Recovery fixture review ${role}\nVERDICT: PASS\nFINDINGS [0]\n## Checks\n` +
    Array.from({ length: 55 }, (_, i) => `Check ${i + 1}: recovery fixture has no findings.`).join('\n') +
    '\n## Summary\nLGTM. No findings.\n']]));
  const testDesign = command => handshake('test-design', 'review', {
    ...reviewFiles, 'test-plan.md': ['test-plan', readFileSync('test-plan.md', 'utf8')],
  }, { testCommand: command, prerequisites: ['local fixture'] });
  const transition = (from, to, verdict = 'PASS') => {
    const result = cli('transition', '--from', from, '--to', to, '--verdict', verdict);
    assert.equal(result.allowed, true, JSON.stringify(result));
    assert.equal(state().currentNode, to);
    return result;
  };

  assert.equal(cli('init', '--entry', 'test-design', '--tier', 'functional', '--no-extensions').created, true);
  testDesign('node -e "process.exit(7)"');
  transition('test-design', 'test-execute');
  const failedPath = `${dir}/nodes/test-execute/run_1/test-command-result.json`;
  const failedBytes = readFileSync(failedPath, 'utf8');
  assert.equal(JSON.parse(failedBytes).exitCode, 7);
  assert.equal(JSON.parse(readFileSync(`${dir}/nodes/test-execute/run_1/handshake.json`)).verdict, 'FAIL');
  const gate = flow === 'build-verify' ? 'gate' : 'gate-test';
  assert.equal(cli('transition', '--from', 'test-execute', '--to', gate, '--verdict', 'PASS').allowed, false);
  assert.equal(cli('transition', '--from', 'test-execute', '--to', 'hotfix', '--verdict', 'ITERATE').allowed, false);
  assert.equal(cli('finalize').finalized, false);

  const route = cli('route', '--node', 'test-execute', '--verdict', 'FAIL');
  assert.equal(route.next, 'brief', JSON.stringify(route));
  assert.equal(cli('route', '--node', 'test-execute', '--verdict', 'ITERATE').next, 'hotfix');
  transition('test-execute', 'brief', 'FAIL');
  const brief = readFileSync('brief.md', 'utf8');
  handshake('brief', 'brief', {
    'build-brief.md': ['brief', brief],
    'brief-lint-result.json': ['report', JSON.stringify(cli('brief-lint', 'brief.md'))],
  });
  transition('brief', 'build');
  handshake('build', 'build');
  transition('build', 'code-review');
  handshake('code-review', 'review', reviewFiles);
  transition('code-review', 'test-design');
  testDesign('node -e "console.log(\'TAP version 13\\n1..1\\nok 1 - recovered\\n# tests 1\\n# fail 0\')"');
  transition('test-design', 'test-execute');
  const passed = JSON.parse(readFileSync(`${dir}/nodes/test-execute/run_2/test-command-result.json`));
  assert.equal(passed.exitCode, 0);
  assert.equal(passed.provenance.sourceRunId, 'run_2');
  assert.equal(readFileSync(failedPath, 'utf8'), failedBytes, 'failed run must remain unchanged');
  transition('test-execute', gate);
  handshake(gate, 'gate');
  if (flow === 'build-verify') {
    const final = cli('finalize', '--strict');
    assert.equal(final.finalized, true, JSON.stringify(final));
    assert.equal(state().status, 'completed');
  } else {
    transition('gate-test', 'acceptance');
  }
  console.log(`PASS: ${flow} preserves FAIL, replans, reruns, and passes its test gate`);
}
JS
