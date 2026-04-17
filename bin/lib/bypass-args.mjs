// bypass-args.mjs — parse CLI flags for extension bypass / whitelist.
// Single source of truth so init, prompt-context, extension-verdict all behave the same.
//
// Flags recognized (highest priority first, after env OPC_DISABLE_EXTENSIONS):
//   --no-extensions           → disable all extensions
//   --extensions <csv>        → whitelist these extensions only
//
// Returns a partial config object suitable for merging into whatever `config`
// is passed to loadExtensions():
//   { noExtensions: true }
//   { extensionWhitelist: ["a","b"] }
//   {} (neither flag was given)

export function parseBypassArgs(args) {
  const out = {};
  if (args.includes("--no-extensions")) {
    out.noExtensions = true;
  }
  const idx = args.indexOf("--extensions");
  if (idx >= 0 && idx < args.length - 1) {
    const raw = args[idx + 1];
    if (typeof raw === "string" && !raw.startsWith("--")) {
      out.extensionWhitelist = raw
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);
    }
  }
  return out;
}
