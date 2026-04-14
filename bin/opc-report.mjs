#!/usr/bin/env node
// OPC Loop/Flow HTML Report Generator
// Reads .harness/ directory and generates a self-contained dark-theme HTML report.
// Usage: node opc-report.mjs --dir .harness --output report.html [--title "My Report"]

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, basename, relative } from 'path';

// --- CLI args ---
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const DIR = arg('dir', null);
const OUTPUT = arg('output', null);
const TITLE = arg('title', 'OPC Report');
if (!DIR) { console.error('Usage: opc-report.mjs --dir <harness-dir> [--output file.html] [--title "..."]'); process.exit(1); }

// --- Helpers ---
function tryReadJSON(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }
function tryRead(p) { try { return readFileSync(p, 'utf8'); } catch { return null; } }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// --- Collect eval files ---
function collectEvals(dir) {
  const nodesDir = join(dir, 'nodes');
  if (!existsSync(nodesDir)) return {};
  const result = {}; // { nodeId: [{ file, content, isR2 }] }
  for (const nodeId of readdirSync(nodesDir).sort()) {
    const nodePath = join(nodesDir, nodeId);
    if (!statSync(nodePath).isDirectory()) continue;
    for (const runDir of readdirSync(nodePath).sort()) {
      const runPath = join(nodePath, runDir);
      if (!statSync(runPath).isDirectory()) continue;
      for (const f of readdirSync(runPath).sort()) {
        if (!f.startsWith('eval-') || !f.endsWith('.md')) continue;
        const content = tryRead(join(runPath, f));
        if (!content) continue;
        if (!result[nodeId]) result[nodeId] = [];
        const isR2 = f.endsWith('-r2.md');
        // Skip non-R2 eval files in R2 node directories (meta-reviews)
        if (!isR2 && nodeId.toLowerCase().startsWith('r2')) continue;
        result[nodeId].push({ file: f, content, isR2, nodeId });
      }
    }
  }
  return result;
}

// --- Parse findings from an eval file ---
const SEV_RE = /\*\*Severity\*\*:?\s*(🔴|🟡|🔵)/;
const STATUS_RE = /\*\*(?:R2\s+)?Status\*?\*?:?\s*(✅|⚠️|❌)/;
const LOCATION_RE = /\*\*Location\*\*:?\s*(.+)/;
const FINDING_HEADING_RE = /^#{2,3}\s+(?:Finding\s+)?(\d+)[\s.:—\-]+(.+)/i;
// Also match: ### N. Title  or  ## Finding N — Title
const FINDING_HEADING_ALT = /^#{2,3}\s+(\d+)\.\s+(.+)/;

function parseFindings(content) {
  const lines = content.split('\n');
  const findings = [];
  let current = null;
  for (const line of lines) {
    let m = line.match(FINDING_HEADING_RE) || line.match(FINDING_HEADING_ALT);
    if (m) {
      if (current) findings.push(current);
      current = { num: m[1], title: m[2].trim(), severity: null, location: null, status: null };
      continue;
    }
    if (!current) continue;
    const sevM = line.match(SEV_RE);
    if (sevM) { current.severity = sevM[1]; continue; }
    const statM = line.match(STATUS_RE);
    if (statM) { current.status = statM[1]; continue; }
    const locM = line.match(LOCATION_RE);
    if (locM) { current.location = locM[1].replace(/`/g, '').trim(); continue; }
  }
  if (current) findings.push(current);
  return findings;
}

// --- Parse verdict from eval ---
function parseVerdict(content) {
  // Format A: ## Verdict\n\n**WORD**  (next-line, bold)
  // Format B: ## Verdict: **WORD**   (inline, bold)
  // Format C: ## Verdict: WORD       (inline, no bold)
  const m = content.match(/##\s*(?:Overall\s+)?Verdict[:\s]*(?:\n+\s*)?\*{0,2}(\w+)\*{0,2}/i);
  return m ? m[1].toUpperCase() : null;
}

// --- Parse counselor name from heading ---
function parseCounselorName(content) {
  const m = content.match(/^#\s+(.+?)(?:\s*—|\s*$)/m);
  return m ? m[1].trim() : null;
}

// --- Main data collection ---
const loopState = tryReadJSON(join(DIR, 'loop-state.json'));
const flowState = tryReadJSON(join(DIR, 'flow-state.json'));
const planMd = tryRead(join(DIR, 'plan.md'));
const evalsByNode = collectEvals(DIR);

// Determine R1 vs R2 nodes from loop-state if available
let unitIds = loopState?.unit_ids || [];

// Collect all R1 and R2 findings
const r1Nodes = []; // { nodeId, counselor, findings[], verdict }
const r2Nodes = []; // { nodeId, counselor, findings[], verdict, fixCounts }

for (const [nodeId, evals] of Object.entries(evalsByNode)) {
  for (const ev of evals) {
    const findings = parseFindings(ev.content);
    const verdict = parseVerdict(ev.content);
    const counselor = parseCounselorName(ev.content) || ev.file.replace('eval-','').replace('.md','').replace(/-r2$/,'');
    if (ev.isR2) {
      const fixed = findings.filter(f => f.status === '✅').length;
      const partial = findings.filter(f => f.status === '⚠️').length;
      const notFixed = findings.filter(f => f.status === '❌').length;
      r2Nodes.push({ nodeId, counselor, findings, verdict, file: ev.file, fixed, partial, notFixed });
    } else {
      r1Nodes.push({ nodeId, counselor, findings, verdict, file: ev.file });
    }
  }
}

// --- Stats ---
const allR1Findings = r1Nodes.flatMap(n => n.findings);
const critCount = allR1Findings.filter(f => f.severity === '🔴').length;
const medCount = allR1Findings.filter(f => f.severity === '🟡').length;
const lowCount = allR1Findings.filter(f => f.severity === '🔵').length;

const allR2Findings = r2Nodes.flatMap(n => n.findings);
const r2Fixed = allR2Findings.filter(f => f.status === '✅').length;
const r2Partial = allR2Findings.filter(f => f.status === '⚠️').length;
const r2NotFixed = allR2Findings.filter(f => f.status === '❌').length;
const hasR2 = r2Nodes.length > 0;

// Overall verdict
function overallVerdict() {
  if (!hasR2) {
    if (critCount > 0) return 'FAIL';
    if (medCount > 0) return 'ITERATE';
    return 'PASS';
  }
  if (r2NotFixed > 0) return 'FAIL';
  if (r2Partial > 0) return 'PASS*';
  return 'PASS';
}

// Node verdict from R1 findings
function nodeVerdict(findings) {
  if (findings.some(f => f.severity === '🔴')) return 'FAIL';
  if (findings.some(f => f.severity === '🟡')) return 'ITERATE';
  return 'PASS';
}
function verdictColor(v) {
  if (v === 'PASS' || v === 'PASS*') return 'var(--green)';
  if (v === 'ITERATE') return 'var(--yellow)';
  return 'var(--red)';
}
function verdictBg(v) {
  if (v === 'PASS' || v === 'PASS*') return 'rgba(34,197,94,0.12)';
  if (v === 'ITERATE') return 'rgba(234,179,8,0.12)';
  return 'rgba(239,68,68,0.12)';
}

// --- Parse plan units ---
function parsePlanUnits(md) {
  if (!md) return [];
  const units = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^-\s+(\S+):\s+(\w+)\s*—\s*(.+)/);
    if (m) units.push({ id: m[1], type: m[2], desc: m[3].trim() });
  }
  return units;
}
const planUnits = parsePlanUnits(planMd);

// --- System info ---
const systemName = loopState?.description || flowState?.template || TITLE;
const dateStr = loopState?._last_modified
  ? new Date(loopState._last_modified).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })
  : new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });

// --- HTML Generation ---
function buildHTML() {
  const verd = overallVerdict();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(TITLE)}</title>
<style>
:root{--bg:#0a0a0f;--surface:#12121a;--surface2:#1a1a26;--border:#2a2a3a;--text:#e4e4ef;--text-dim:#8888a0;--accent:#6366f1;--green:#22c55e;--yellow:#eab308;--red:#ef4444;--blue:#3b82f6}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.6;padding:2rem}
.container{max-width:1200px;margin:0 auto}
.header{text-align:center;padding:3rem 2rem;background:linear-gradient(135deg,rgba(99,102,241,.15),rgba(79,70,229,.05));border-radius:16px;border:1px solid var(--border);margin-bottom:2rem}
.header h1{font-size:2rem;font-weight:700;letter-spacing:-0.02em}
.header .subtitle{color:var(--text-dim);margin-top:.5rem;font-size:1.1rem}
.header .date{color:var(--accent);margin-top:.5rem;font-size:.9rem}
.section{margin-bottom:2rem}
.section-title{font-size:1.3rem;font-weight:600;margin-bottom:1rem;padding-bottom:.5rem;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:.5rem}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:1.5rem;margin-bottom:1rem}

/* Stats */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:1rem;margin-bottom:2rem}
.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:1.25rem;text-align:center}
.stat-card .number{font-size:2.2rem;font-weight:700;line-height:1}
.stat-card .label{font-size:.85rem;color:var(--text-dim);margin-top:.25rem}

/* Pipeline */
.pipeline{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;padding:1.5rem;background:var(--surface);border:1px solid var(--border);border-radius:12px;margin-bottom:2rem;overflow-x:auto}
.pipe-node{padding:.5rem 1rem;border-radius:8px;font-size:.8rem;font-weight:600;border:1px solid var(--border);background:var(--surface2);white-space:nowrap;position:relative}
.pipe-node.active{border-color:var(--accent);box-shadow:0 0 12px rgba(99,102,241,.2)}
.pipe-arrow{color:var(--text-dim);font-size:1.1rem;user-select:none}

/* Findings table */
.findings-table{width:100%;border-collapse:collapse;font-size:.9rem}
.findings-table th{text-align:left;padding:.6rem .8rem;border-bottom:2px solid var(--border);color:var(--text-dim);font-weight:500;font-size:.8rem;text-transform:uppercase;letter-spacing:.05em}
.findings-table td{padding:.6rem .8rem;border-bottom:1px solid var(--border);vertical-align:top}
.findings-table tr:last-child td{border-bottom:none}
.findings-table .sev{font-size:1.1rem;text-align:center;width:2.5rem}
.findings-table .loc{color:var(--text-dim);font-size:.8rem;font-family:'SF Mono',Menlo,monospace}

/* Badge */
.badge{display:inline-block;padding:.15rem .6rem;border-radius:6px;font-size:.75rem;font-weight:600;letter-spacing:.03em}

/* Node card */
.node-header{display:flex;align-items:center;gap:.75rem;margin-bottom:1rem}
.node-header h3{font-size:1.05rem;font-weight:600}

/* R2 */
.r2-card{display:flex;align-items:center;gap:1rem;padding:1rem 1.25rem;background:var(--surface);border:1px solid var(--border);border-radius:10px;margin-bottom:.75rem}
.r2-card .counselor{font-weight:600;min-width:160px}
.r2-fix-counts{display:flex;gap:.75rem;font-size:.85rem}
.r2-fix-counts span{padding:.15rem .5rem;border-radius:5px}

/* Fix list */
.fix-item{display:flex;gap:.75rem;padding:.6rem 0;border-bottom:1px solid rgba(42,42,58,.5);font-size:.9rem}
.fix-item:last-child{border-bottom:none}
.fix-icon{font-size:1rem;flex-shrink:0;margin-top:.1rem}
.fix-title{flex:1}
</style>
</head>
<body>
<div class="container">
${renderHeader(verd)}
${renderPipeline()}
${renderStats(verd)}
${renderR1Findings()}
${hasR2 ? renderFixes() : ''}
${hasR2 ? renderR2Verdicts() : ''}
${renderFooter()}
</div>
</body>
</html>`;
}

function renderHeader(verd) {
  return `<div class="header">
<h1>${esc(TITLE)}</h1>
<div class="subtitle">${esc(systemName)}</div>
<div class="date">${esc(dateStr)}${loopState?._git_head ? ` &middot; <code style="font-size:.8rem;opacity:.6">${esc(loopState._git_head.slice(0,8))}</code>` : ''}</div>
<div style="margin-top:1rem"><span class="badge" style="background:${verdictBg(verd)};color:${verdictColor(verd)};font-size:1rem;padding:.3rem 1.2rem">${esc(verd)}</span></div>
</div>`;
}

function renderPipeline() {
  const nodes = planUnits.length ? planUnits : (unitIds.length ? unitIds.map(id => ({ id, type: id.startsWith('R') ? 'review' : id.startsWith('F') ? 'fix' : 'deliver', desc: '' })) : []);
  if (!nodes.length) return '';
  const completedUnits = new Set((loopState?._tick_history || []).map(t => t.unit));
  // Supplement with filesystem evidence: if a unit's node dir has eval files, it completed
  for (const n of nodes) {
    if (completedUnits.has(n.id)) continue;
    const unitEvalDir = join(DIR, 'nodes', n.id, 'run_1');
    if (existsSync(unitEvalDir) && readdirSync(unitEvalDir).some(f => f.startsWith('eval-')))
      completedUnits.add(n.id);
  }
  // If loop status is 'completed', mark all units as completed
  if (loopState?.status === 'completed') {
    for (const n of nodes) completedUnits.add(n.id);
  }
  const current = loopState?.unit || flowState?.currentNode || '';
  const items = nodes.map(n => {
    const done = completedUnits.has(n.id);
    const isCurrent = n.id === current;
    const typeIcon = n.type === 'review' ? '🔍' : n.type === 'fix' ? '🔧' : n.type === 'deliver' ? '📦' : '⚙️';
    const bg = done ? 'rgba(34,197,94,.08)' : isCurrent ? 'rgba(99,102,241,.12)' : '';
    const borderColor = done ? 'var(--green)' : isCurrent ? 'var(--accent)' : 'var(--border)';
    return `<div class="pipe-node" style="border-color:${borderColor};${bg ? `background:${bg}` : ''}">${typeIcon} ${esc(n.id)}</div>`;
  });
  return `<div class="section">
<div class="section-title">📊 Pipeline Flow</div>
<div class="pipeline">${items.join('<span class="pipe-arrow">→</span>')}</div>
</div>`;
}

function renderStats(verd) {
  const cards = [
    { num: critCount, label: '🔴 Critical', color: 'var(--red)' },
    { num: medCount, label: '🟡 Medium', color: 'var(--yellow)' },
    { num: lowCount, label: '🔵 Low', color: 'var(--blue)' },
  ];
  if (hasR2) {
    cards.push({ num: r2Fixed, label: '✅ Fixed', color: 'var(--green)' });
    cards.push({ num: r2Partial, label: '⚠️ Partial', color: 'var(--yellow)' });
    cards.push({ num: r2NotFixed, label: '❌ Not Fixed', color: 'var(--red)' });
  }
  cards.push({ num: verd, label: 'Final Verdict', color: verdictColor(verd), isText: true });
  return `<div class="stats">${cards.map(c => `<div class="stat-card">
<div class="number" style="color:${c.color}">${c.isText ? esc(c.num) : c.num}</div>
<div class="label">${esc(c.label)}</div>
</div>`).join('')}</div>`;
}

function renderR1Findings() {
  if (!r1Nodes.length) return '<div class="section"><div class="section-title">Round 1 Findings</div><div class="card"><p style="color:var(--text-dim)">No R1 eval files found.</p></div></div>';
  return `<div class="section">
<div class="section-title">🔍 Round 1 Findings</div>
${r1Nodes.map(node => {
    const v = node.verdict || nodeVerdict(node.findings);
    const sevFindings = node.findings.filter(f => f.severity);
    return `<div class="card">
<div class="node-header">
<h3>${esc(node.nodeId)} — ${esc(node.counselor)}</h3>
<span class="badge" style="background:${verdictBg(v)};color:${verdictColor(v)}">${esc(v)}</span>
<span style="color:var(--text-dim);font-size:.8rem">(${node.findings.filter(f=>f.severity==='🔴').length}🔴 ${node.findings.filter(f=>f.severity==='🟡').length}🟡 ${node.findings.filter(f=>f.severity==='🔵').length}🔵)</span>
</div>
${sevFindings.length ? `<table class="findings-table">
<thead><tr><th>Sev</th><th>Finding</th><th>Location</th></tr></thead>
<tbody>${sevFindings.map(f => `<tr>
<td class="sev">${f.severity || '—'}</td>
<td>${esc(f.title)}</td>
<td class="loc">${f.location ? esc(f.location) : '—'}</td>
</tr>`).join('')}</tbody>
</table>` : '<p style="color:var(--text-dim);font-size:.9rem">No severity findings — all checks passed.</p>'}
</div>`;
  }).join('')}
</div>`;
}

function renderFixes() {
  // Collect all R2 findings that were fixed
  const fixed = allR2Findings.filter(f => f.status === '✅');
  const partial = allR2Findings.filter(f => f.status === '⚠️');
  if (!fixed.length && !partial.length) return '';
  return `<div class="section">
<div class="section-title">🔧 Fixes Applied</div>
<div class="card">
${fixed.length ? `<h4 style="color:var(--green);margin-bottom:.75rem">✅ Fixed (${fixed.length})</h4>
${fixed.map(f => `<div class="fix-item"><span class="fix-icon">✅</span><span class="fix-title">${esc(f.title)}</span></div>`).join('')}` : ''}
${partial.length ? `<h4 style="color:var(--yellow);margin-top:1rem;margin-bottom:.75rem">⚠️ Partially Fixed (${partial.length})</h4>
${partial.map(f => `<div class="fix-item"><span class="fix-icon">⚠️</span><span class="fix-title">${esc(f.title)}</span></div>`).join('')}` : ''}
</div>
</div>`;
}

// Infer R2 verdict from fix counts when parseVerdict fails
function inferR2Verdict(n) {
  if (n.notFixed > 0) return 'FAIL';
  if (n.partial > 0) return 'PASS*';
  if (n.fixed > 0) return 'PASS';
  return 'UNKNOWN';
}

function renderR2Verdicts() {
  if (!r2Nodes.length) return '';
  return `<div class="section">
<div class="section-title">📋 Round 2 Verdicts</div>
${r2Nodes.map(n => {
    const v = n.verdict || inferR2Verdict(n);
    return `<div class="r2-card">
<span class="counselor">${esc(n.counselor)}</span>
<span class="badge" style="background:${verdictBg(v)};color:${verdictColor(v)}">${esc(v)}</span>
<div class="r2-fix-counts">
${n.fixed ? `<span style="background:rgba(34,197,94,.1);color:var(--green)">✅ ${n.fixed}</span>` : ''}
${n.partial ? `<span style="background:rgba(234,179,8,.1);color:var(--yellow)">⚠️ ${n.partial}</span>` : ''}
${n.notFixed ? `<span style="background:rgba(239,68,68,.1);color:var(--red)">❌ ${n.notFixed}</span>` : ''}
</div>
</div>`;
  }).join('')}
</div>`;
}

function renderFooter() {
  const totalFindings = allR1Findings.filter(f => f.severity).length;
  const tickCount = loopState?._tick_history?.length || 0;
  return `<div style="text-align:center;padding:2rem 0;color:var(--text-dim);font-size:.8rem;border-top:1px solid var(--border);margin-top:2rem">
Generated by <strong>opc-report.mjs</strong> &middot; ${totalFindings} findings across ${r1Nodes.length} reviewers${hasR2 ? ` &middot; ${r2Fixed} fixed, ${r2Partial} partial, ${r2NotFixed} unresolved` : ''}${tickCount ? ` &middot; ${tickCount} ticks` : ''}
</div>`;
}

// --- Output ---
const html = buildHTML();
if (OUTPUT) {
  writeFileSync(OUTPUT, html);
  console.log(`Report written to ${OUTPUT}`);
} else {
  process.stdout.write(html);
}
