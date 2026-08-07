import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  runOtelGenerationConfigWatcherRuntime,
  testing,
} from "./otel-generation-config-watcher-runtime.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

describe("OTEL generation config watcher runtime", () => {
  it(
    "keeps all three signals on the active same-PID provider generation",
    { timeout: 300_000 },
    async () => {
      const artifactBase = await fs.mkdtemp(
        path.join(os.tmpdir(), "otel-generation-config-watcher-"),
      );
      tempDirs.push(artifactBase);

      const { evidence, summary } = await runOtelGenerationConfigWatcherRuntime({
        artifactBase,
        repoRoot: process.cwd(),
      });

      expect(evidence.schemaVersion).toBe(2);
      expect(evidence.entries[0]?.result.status).toBe("pass");
      expect(summary).toMatchObject({
        collectorAPostReadyRequestCount: 0,
        failures: [],
        noRespawn: true,
        passed: true,
        pid: { same: true },
        readyAfterMutation: true,
        restartLogObserved: true,
      });
      for (const collector of [summary.collectorA, summary.collectorB]) {
        expect(collector).toMatchObject({
          failedRequestCount: 0,
          logCorrelationValid: true,
          parentGraphValid: true,
          requiredSpanNames: ["openclaw.model.call", "openclaw.run"],
          traceparentAccepted: true,
        });
        expect(collector?.signalRequestCounts).toMatchObject({
          logs: expect.any(Number),
          metrics: expect.any(Number),
          traces: expect.any(Number),
        });
        expect(collector?.signalRequestCounts.logs).toBeGreaterThan(0);
        expect(collector?.signalRequestCounts.metrics).toBeGreaterThan(0);
        expect(collector?.signalRequestCounts.traces).toBeGreaterThan(0);
      }

      const summaryText = await fs.readFile(
        path.join(artifactBase, "otel-generation-config-watcher-summary.json"),
        "utf8",
      );
      expect(summaryText).not.toContain(artifactBase);
      expect(summaryText).not.toContain("http://127.0.0.1");
      const evidenceText = await fs.readFile(path.join(artifactBase, "qa-evidence.json"), "utf8");
      expect(evidenceText).not.toContain(artifactBase);
    },
  );

  it("rejects missing output-dir values", () => {
    expect(() => testing.parseOptions(["--output-dir"])).toThrow("--output-dir requires a value");
  });

  it("redacts local failure details before writing artifacts", () => {
    const localEndpoint = `http://${["127", "0", "0", "1"].join(".")}:4318`;
    const gatewayToken = "qa-suite-12345678-1234-1234-1234-123456789abc";
    const failure = testing.sanitizeProofFailure(
      new Error(
        `failed at /workspace/repo/test.ts via ${localEndpoint} in /tmp/openclaw-qa-suite-private with ${gatewayToken}`,
      ),
      "/workspace/repo",
    );
    expect(failure).toContain("<repo>");
    expect(failure).toContain("<local-endpoint>");
    expect(failure).toContain("<temp-path>");
    expect(failure).toContain("<gateway-token>");
    expect(failure).not.toContain("/workspace/repo");
    expect(failure).not.toContain(localEndpoint);
  });

  it("accepts one external parent and rejects cyclic exported spans", () => {
    const externalParentSpanId = "1111111111111111";
    const rootSpanId = "aaaaaaaaaaaaaaaa";
    const childSpanId = "bbbbbbbbbbbbbbbb";
    const base = {
      attributes: {},
      name: "span",
      parent: true,
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    expect(
      testing.inspectParentGraph([
        { ...base, parentSpanId: externalParentSpanId, spanId: rootSpanId },
        { ...base, parentSpanId: rootSpanId, spanId: childSpanId },
      ]),
    ).toEqual({
      externalParentSpanIds: [externalParentSpanId],
      valid: true,
    });
    expect(
      testing.inspectParentGraph([
        { ...base, parentSpanId: childSpanId, spanId: rootSpanId },
        { ...base, parentSpanId: rootSpanId, spanId: childSpanId },
      ]),
    ).toMatchObject({ valid: false });
  });
});
