// bypass-args.test.mjs — Node.js built-in test runner
// Run: node --test bin/lib/bypass-args.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseBypassArgs } from "./bypass-args.mjs";

describe("parseBypassArgs", () => {
  test("empty args → {}", () => {
    assert.deepEqual(parseBypassArgs([]), {});
  });

  test("unrelated args → {}", () => {
    assert.deepEqual(parseBypassArgs(["--flow", "review", "--dir", ".harness"]), {});
  });

  test("--no-extensions → { noExtensions: true }", () => {
    assert.deepEqual(parseBypassArgs(["--no-extensions"]), { noExtensions: true });
  });

  test("--extensions alpha,beta → whitelist array", () => {
    assert.deepEqual(parseBypassArgs(["--extensions", "alpha,beta"]), {
      extensionWhitelist: ["alpha", "beta"],
    });
  });

  test("--extensions with whitespace → trimmed", () => {
    assert.deepEqual(parseBypassArgs(["--extensions", " alpha , beta , "]), {
      extensionWhitelist: ["alpha", "beta"],
    });
  });

  test("--extensions with empty csv segments → filtered", () => {
    assert.deepEqual(parseBypassArgs(["--extensions", "alpha,,beta,"]), {
      extensionWhitelist: ["alpha", "beta"],
    });
  });

  test("--extensions at end without value → ignored", () => {
    assert.deepEqual(parseBypassArgs(["--extensions"]), {});
  });

  test("--extensions followed by another flag → ignored (no value)", () => {
    assert.deepEqual(parseBypassArgs(["--extensions", "--no-extensions"]), {
      noExtensions: true,
    });
  });

  test("both --no-extensions and --extensions → both present in output", () => {
    // Let resolveBypass decide priority; parser just reports what it saw.
    assert.deepEqual(parseBypassArgs(["--no-extensions", "--extensions", "alpha"]), {
      noExtensions: true,
      extensionWhitelist: ["alpha"],
    });
  });

  test("single extension in whitelist", () => {
    assert.deepEqual(parseBypassArgs(["--extensions", "solo"]), {
      extensionWhitelist: ["solo"],
    });
  });
});
