// Advisory file locking using .lock files with PID + timestamp.
// Uses O_EXCL for atomic creation; stale lock detection via dead PID.
// Depends on: (none — self-contained)

import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { randomBytes } from "crypto";

// Synchronous sleep without spawning a shell process.
// Uses SharedArrayBuffer + Atomics.wait for zero-dependency sync delay.
const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function sleepMs(ms) {
  Atomics.wait(_sleepBuf, 0, 0, ms);
}

/**
 * Check if a given PID is alive.
 */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempt to acquire an advisory lock on `filePath`.
 *
 * @param {string} filePath  — path to the file being locked (e.g. flow-state.json)
 * @param {object} opts
 * @param {number} opts.timeout   — ms to wait before giving up (default 5000)
 * @param {string} opts.command   — name of the command acquiring the lock
 * @returns {{ acquired: boolean, release?: Function, holder?: object }}
 */
export function lockFile(filePath, opts = {}) {
  const { timeout = 5000, command = "unknown" } = opts;
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + timeout;
  const maxRetries = 200; // Safety cap: 200 * 50ms = 10s hard limit
  let retries = 0;

  while (retries++ < maxRetries) {
    // Try to read existing lock
    if (existsSync(lockPath)) {
      let holder;
      try {
        holder = JSON.parse(readFileSync(lockPath, "utf8"));
      } catch {
        // Corrupt lock file — treat as stale
        try { unlinkSync(lockPath); } catch { /* race — ok */ }
        // Retry atomic acquire
        continue;
      }

      if (holder) {
        // Stale lock detection: holder PID is dead
        if (!isPidAlive(holder.pid)) {
          try { unlinkSync(lockPath); } catch { /* race — ok */ }
          // Retry atomic acquire
          continue;
        } else {
          // Lock held by a live process — wait or give up
          if (Date.now() >= deadline) {
            return { acquired: false, holder };
          }
          sleepMs(50);
          continue;
        }
      }
    }

    // Attempt to create the lock atomically using O_EXCL (O_CREAT|O_EXCL).
    // If the file already exists, writeFileSync with flag "wx" throws EEXIST.
    const nonce = randomBytes(8).toString("hex");
    const lockData = {
      pid: process.pid,
      nonce,
      timestamp: new Date().toISOString(),
      command,
    };

    try {
      writeFileSync(lockPath, JSON.stringify(lockData, null, 2) + "\n", { flag: "wx" });
    } catch (err) {
      if (err.code === "EEXIST") {
        // Another process created the lock between our check and write — retry
        if (Date.now() >= deadline) {
          // Try to read who holds it
          try {
            const existing = JSON.parse(readFileSync(lockPath, "utf8"));
            return { acquired: false, holder: existing };
          } catch {
            return { acquired: false, holder: { pid: -1, timestamp: null, command: "unknown" } };
          }
        }
        sleepMs(50);
        continue;
      }
      // Other write error (permissions, etc.)
      if (Date.now() >= deadline) {
        return { acquired: false, holder: { pid: -1, timestamp: null, command: "unknown" } };
      }
      sleepMs(50);
      continue;
    }

    // Lock acquired — return release function
    const release = () => {
      try {
        // Only remove if we still own it (check pid + nonce to prevent PID-reuse race)
        if (existsSync(lockPath)) {
          const current = JSON.parse(readFileSync(lockPath, "utf8"));
          if (current.pid === process.pid && current.nonce === nonce) {
            unlinkSync(lockPath);
          }
        }
      } catch {
        // Best-effort cleanup
      }
    };

    return { acquired: true, release };
  }

  // maxRetries exceeded (safety belt for clock drift)
  return { acquired: false, holder: { pid: -1, timestamp: null, command: "unknown" } };
}
