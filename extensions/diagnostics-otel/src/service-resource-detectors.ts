import { diag } from "@opentelemetry/api";
import { getStringFromEnv, getStringListFromEnv } from "@opentelemetry/core";
import {
  envDetector,
  hostDetector,
  osDetector,
  processDetector,
  serviceInstanceIdDetector,
  type ResourceDetector,
} from "@opentelemetry/resources";

const RESOURCE_DETECTOR_NAMES = [
  ["env", envDetector],
  ["host", hostDetector],
  ["os", osDetector],
  ["process", processDetector],
  ["serviceinstanceid", serviceInstanceIdDetector],
] as const satisfies ReadonlyArray<readonly [string, ResourceDetector]>;

/**
 * Mirrors the pinned @opentelemetry/sdk-node resource-detector selection
 * contract (sdk-node 0.221.0 utils.getResourceDetectorsFromEnv): an explicit
 * OTEL_NODE_RESOURCE_DETECTORS list selects detectors by name ("all" selects
 * every supported detector, "none" selects none), while an unset variable
 * keeps the NodeSDK default of env + process + host. Invalid names warn and
 * are skipped exactly like NodeSDK.
 */
export function resolveResourceDetectors(): ResourceDetector[] {
  const configured = getStringFromEnv("OTEL_NODE_RESOURCE_DETECTORS");
  if (configured === undefined) {
    return [envDetector, processDetector, hostDetector];
  }
  const fromEnv = getStringListFromEnv("OTEL_NODE_RESOURCE_DETECTORS") ?? ["all"];
  if (fromEnv.includes("all")) {
    return RESOURCE_DETECTOR_NAMES.map(([, detector]) => detector);
  }
  if (fromEnv.includes("none")) {
    return [];
  }
  return fromEnv.flatMap((name) => {
    const detector = RESOURCE_DETECTOR_NAMES.find(([candidate]) => candidate === name)?.[1];
    if (!detector) {
      diag.warn(
        `Invalid resource detector "${name}" specified in the environment variable OTEL_NODE_RESOURCE_DETECTORS`,
      );
    }
    return detector ? [detector] : [];
  });
}
