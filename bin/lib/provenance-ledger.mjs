import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { createHash, createHmac, randomBytes } from "crypto";
import { homedir } from "os";
import { dirname, join } from "path";

const LEDGER_NAME = ".opc-provenance.jsonl";
const KEY_PATH = process.env.OPC_PROVENANCE_KEY_FILE || join(homedir(), ".opc", "provenance-key");

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function signingKey() {
  if (existsSync(KEY_PATH)) return readFileSync(KEY_PATH);
  mkdirSync(dirname(KEY_PATH), { recursive: true });
  const key = randomBytes(32).toString("hex");
  writeFileSync(KEY_PATH, key, { mode: 0o600 });
  return Buffer.from(key);
}

function signPayload(payload) {
  return createHmac("sha256", signingKey()).update(canonical(payload)).digest("hex");
}

function ledgerPath(sessionDir) {
  return join(sessionDir, LEDGER_NAME);
}

function validateRecord(record, previousHash) {
  if (!record || typeof record !== "object") return { ok: false, error: "ledger record is not an object" };
  const { signature, recordHash, ...payload } = record;
  if (payload.previousHash !== previousHash) return { ok: false, error: "ledger hash chain mismatch" };
  if (signature !== signPayload(payload)) return { ok: false, error: "ledger signature mismatch" };
  const actualHash = sha256(canonical({ ...payload, signature }));
  if (recordHash !== actualHash) return { ok: false, error: "ledger record hash mismatch" };
  return { ok: true, payload, recordHash };
}

export function appendProvenanceEvent(sessionDir, event) {
  const path = ledgerPath(sessionDir);
  const previousHash = latestLedgerHash(sessionDir);
  const payload = { version: 1, timestamp: new Date().toISOString(), previousHash, ...event };
  const signature = signPayload(payload);
  const recordHash = sha256(canonical({ ...payload, signature }));
  appendFileSync(path, JSON.stringify({ ...payload, signature, recordHash }) + "\n", { mode: 0o600 });
  return { kind: "opc-hmac-ledger", path: LEDGER_NAME, recordHash };
}

export function findProvenanceEvent(sessionDir, recordHash) {
  const path = ledgerPath(sessionDir);
  if (!recordHash) return { ok: false, error: "missing ledger record hash" };
  if (!existsSync(path)) return { ok: false, error: "provenance ledger missing" };
  const lines = readFileSync(path, "utf8").split(/\n/).filter(Boolean);
  let previousHash = null;
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { return { ok: false, error: "provenance ledger corrupt" }; }
    const validated = validateRecord(record, previousHash);
    if (!validated.ok) return validated;
    previousHash = validated.recordHash;
    if (validated.recordHash === recordHash) return { ok: true, event: validated.payload };
  }
  return { ok: false, error: "provenance ledger record not found" };
}

function latestLedgerHash(sessionDir) {
  const path = ledgerPath(sessionDir);
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").split(/\n/).filter(Boolean);
  let previousHash = null;
  for (const line of lines) {
    const record = JSON.parse(line);
    const validated = validateRecord(record, previousHash);
    if (!validated.ok) return null;
    previousHash = validated.recordHash;
  }
  return previousHash;
}
