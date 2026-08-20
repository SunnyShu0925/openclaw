import { isRecord } from "./record-coerce.js";

/** Unwraps a paired-node invoke envelope (`{ payloadJSON, payload }`), parsing `payloadJSON` with a stable error on malformed JSON, falling back to the structured `payload` field. */
export function unwrapNodePayloadJSON(
  value: unknown,
  errorMessage = "node returned malformed session catalog JSON",
): unknown {
  if (!isRecord(value)) {
    return value;
  }
  if (typeof value.payloadJSON === "string" && value.payloadJSON.trim()) {
    try {
      return JSON.parse(value.payloadJSON) as unknown;
    } catch (error) {
      throw new Error(errorMessage, { cause: error });
    }
  }
  return "payload" in value ? value.payload : value;
}
