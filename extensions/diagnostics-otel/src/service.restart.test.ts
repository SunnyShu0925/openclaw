// Real-SDK restart regression for #119997: an in-process Gateway restart must
// keep diagnostics telemetry flowing to a fresh collector. Owned generations
// use private trace and metric providers, so a shutdown generation never
// leaves a stale global provider behind and the next generation exports
// normally without touching the global registrations.
import { context, metrics, propagation, trace } from "@opentelemetry/api";
import {
  createDiagnosticTraceContext,
  emitTrustedDiagnosticEventWithPrivateData,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, expect, test } from "vitest";
import { startLocalOtlpReceiver } from "../../../test/e2e/qa-lab/runtime/otel-test-support.js";
import { createDiagnosticsOtelService } from "./service.js";
import { createOtelContext } from "./service.test-helpers.js";

const PRELOAD_ENV = "OPENCLAW_OTEL_PRELOADED";
const OTEL_GLOBAL_API_KEY = Symbol.for("opentelemetry.js.api.1");

type OtelGlobalRegistrations = {
  context?: unknown;
  metrics?: unknown;
  propagation?: unknown;
  trace?: unknown;
};

function registeredOtelGlobals(): OtelGlobalRegistrations | undefined {
  return (globalThis as unknown as Record<symbol, OtelGlobalRegistrations | undefined>)[
    OTEL_GLOBAL_API_KEY
  ];
}

function releasePreloadedOtelGlobals() {
  context.disable();
  metrics.disable();
  propagation.disable();
  trace.disable();
  process.env[PRELOAD_ENV] = "0";
}

const emit = (event: Parameters<typeof emitTrustedDiagnosticEventWithPrivateData>[0]) =>
  emitTrustedDiagnosticEventWithPrivateData(event, {});

afterEach(() => {
  resetDiagnosticEventsForTest();
});

test("keeps exporting to a fresh collector after an in-process restart", async () => {
  const receiverA = startLocalOtlpReceiver();
  const receiverB = startLocalOtlpReceiver();
  const portA = await receiverA.listen();
  const portB = await receiverB.listen();
  releasePreloadedOtelGlobals();
  const service = createDiagnosticsOtelService();
  let ctxA: ReturnType<typeof createOtelContext> | undefined;
  let ctxB: ReturnType<typeof createOtelContext> | undefined;
  const emitRun = (runId: string) => {
    const traceContext = createDiagnosticTraceContext();
    emit({
      type: "run.started",
      runId,
      provider: "openai",
      model: "gpt-5.4",
      trace: traceContext,
    });
    emit({
      type: "model.call.completed",
      runId,
      callId: `call-${runId}`,
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 10,
      usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, total: 8 },
      trace: traceContext,
    });
    emit({
      type: "run.completed",
      runId,
      provider: "openai",
      model: "gpt-5.4",
      outcome: "completed",
      durationMs: 25,
      trace: traceContext,
    });
  };

  try {
    ctxA = createOtelContext(`http://127.0.0.1:${portA}`, {
      traces: true,
      metrics: true,
      logs: false,
    });
    await service.start(ctxA);
    emitRun("run-generation-a");
    await waitForDiagnosticEventsDrained();
    await service.stop?.(ctxA);

    ctxB = createOtelContext(`http://127.0.0.1:${portB}`, {
      traces: true,
      metrics: true,
      logs: false,
    });
    await service.start(ctxB);
    emitRun("run-generation-b");
    await waitForDiagnosticEventsDrained();
    await service.stop?.(ctxB);
    await waitForDiagnosticEventsDrained();

    // Generation A exported to collector A; generation B exported to collector
    // B. With the pre-fix lifecycle, generation B exported zero traces and
    // zero metrics because it could not replace the shutdown global providers.
    expect(new Set(receiverA.capturedRequests.map((request) => request.path))).toEqual(
      new Set(["/v1/traces", "/v1/metrics"]),
    );
    expect(
      receiverA.capturedRequests
        .filter((request) => request.signal === "traces")
        .every((request) => request.spanCount > 0),
    ).toBe(true);
    expect(new Set(receiverB.capturedRequests.map((request) => request.path))).toEqual(
      new Set(["/v1/traces", "/v1/metrics"]),
    );
    expect(
      receiverB.capturedRequests
        .filter((request) => request.signal === "traces")
        .every((request) => request.spanCount > 0),
    ).toBe(true);

    // Owned mode must never register global providers; preloaded mode is the
    // only owner of the globals.
    const globals = registeredOtelGlobals();
    expect(globals?.trace).toBeUndefined();
    expect(globals?.metrics).toBeUndefined();
  } finally {
    await service.stop?.(ctxB ?? ctxA!);
    await receiverA.close();
    await receiverB.close();
  }
}, 30_000);
