// Regression coverage for empty-string values on sensitive paths.
// Split out from redact-snapshot.test.ts so the empty-string redaction
// behavior has a dedicated, focused test file.

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { REDACTED_SENTINEL, redactConfigSnapshot } from "./redact-snapshot.js";
import { makeSnapshot, restoreRedactedValues } from "./redact-snapshot.test-helpers.js";
import { buildConfigSchemaCore } from "./schema.js";

describe("redactConfigSnapshot empty-string values", () => {
  it("does not redact empty-string values on sensitive paths", () => {
    const hints = buildConfigSchemaCore().uiHints;
    const snapshot = makeSnapshot({
      mcp: {
        servers: {
          remote: {
            url: "https://example.com/mcp",
            headers: {
              Authorization: "sample-secret-value",
              "X-Empty": "",
              "X-Blank": "   ",
            },
          },
        },
      },
    });

    const result = redactConfigSnapshot(snapshot, hints);
    const servers = (result.config.mcp as { servers: Record<string, Record<string, unknown>> })
      .servers;
    const headers = expectDefined(servers.remote, "servers.remote test invariant")
      .headers as Record<string, string>;

    // Real secrets are still redacted.
    expect(headers.Authorization).toBe(REDACTED_SENTINEL);
    // Empty and whitespace-only values are not redacted.
    expect(headers["X-Empty"]).toBe("");
    expect(headers["X-Blank"]).toBe("   ");

    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.mcp.servers.remote.headers.Authorization).toBe("sample-secret-value");
    expect(restored.mcp.servers.remote.headers["X-Empty"]).toBe("");
    expect(restored.mcp.servers.remote.headers["X-Blank"]).toBe("   ");
  });
});
