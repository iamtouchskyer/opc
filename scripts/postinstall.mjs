#!/usr/bin/env node

// Delegate to bin/opc.mjs install
import { execFileSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

try {
  execFileSync(process.execPath, [join(__dirname, "..", "bin", "opc.mjs"), "install"], {
    stdio: "inherit",
  });
} catch (err) {
  console.warn(`⚠ Postinstall failed. Run 'opc install' manually.`);
  console.warn(`  Error: ${err.message}`);
}
