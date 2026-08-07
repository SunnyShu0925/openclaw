// Real-SDK regression for the ClawSweeper P1 on #119997: owned mode must
// honor the pinned NodeSDK resource-detector selection contract, including
// the OTEL_NODE_RESOURCE_DETECTORS opt-out ("none") and subset selection.
import {
  detectResources,
  envDetector,
  hostDetector,
  osDetector,
  processDetector,
  resourceFromAttributes,
  serviceInstanceIdDetector,
} from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { expect, test } from "vitest";
import { resolveResourceDetectors } from "./service-resource-detectors.js";

test("selects resource detectors per the pinned NodeSDK contract", () => {
  delete process.env.OTEL_NODE_RESOURCE_DETECTORS;
  expect(resolveResourceDetectors()).toEqual([envDetector, processDetector, hostDetector]);
  try {
    process.env.OTEL_NODE_RESOURCE_DETECTORS = "none";
    expect(resolveResourceDetectors()).toEqual([]);

    process.env.OTEL_NODE_RESOURCE_DETECTORS = "process";
    expect(resolveResourceDetectors()).toEqual([processDetector]);

    process.env.OTEL_NODE_RESOURCE_DETECTORS = "all";
    expect(resolveResourceDetectors()).toEqual([
      envDetector,
      hostDetector,
      osDetector,
      processDetector,
      serviceInstanceIdDetector,
    ]);
  } finally {
    delete process.env.OTEL_NODE_RESOURCE_DETECTORS;
  }
});

test("does not export host/process resource attributes when detectors are disabled", async () => {
  delete process.env.OTEL_NODE_RESOURCE_DETECTORS;
  process.env.OTEL_NODE_RESOURCE_DETECTORS = "none";
  try {
    const resourceExporter = new InMemorySpanExporter();
    const resourceProvider = new BasicTracerProvider({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "openclaw-detector-none" }).merge(
        detectResources({ detectors: resolveResourceDetectors() }),
      ),
      spanProcessors: [new SimpleSpanProcessor(resourceExporter)],
    });
    resourceProvider.getTracer("openclaw-detector-test").startSpan("detector-test").end();
    await resourceProvider.forceFlush();

    const span = resourceExporter.getFinishedSpans()[0];
    expect(span?.resource.attributes["host.name"]).toBeUndefined();
    expect(span?.resource.attributes["process.pid"]).toBeUndefined();
    expect(span?.resource.attributes["os.type"]).toBeUndefined();
    expect(span?.resource.attributes["service.name"]).toBe("openclaw-detector-none");
  } finally {
    delete process.env.OTEL_NODE_RESOURCE_DETECTORS;
  }
});

test("exports host/process resource attributes with the default detectors", async () => {
  delete process.env.OTEL_NODE_RESOURCE_DETECTORS;
  try {
    const resourceExporter = new InMemorySpanExporter();
    const resourceProvider = new BasicTracerProvider({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "openclaw-detector-default" }).merge(
        detectResources({ detectors: resolveResourceDetectors() }),
      ),
      spanProcessors: [new SimpleSpanProcessor(resourceExporter)],
    });
    resourceProvider.getTracer("openclaw-detector-test").startSpan("detector-test").end();
    await resourceProvider.forceFlush();

    const span = resourceExporter.getFinishedSpans()[0];
    expect(span?.resource.attributes["host.name"]).toBeDefined();
    expect(span?.resource.attributes["process.pid"]).toBeDefined();
    expect(span?.resource.attributes["service.name"]).toBe("openclaw-detector-default");
  } finally {
    delete process.env.OTEL_NODE_RESOURCE_DETECTORS;
  }
});
