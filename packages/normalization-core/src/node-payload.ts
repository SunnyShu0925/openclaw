import { isRecord } from "./record-coerce.js";

/**
 * Unwraps a paired-node invoke envelope (`{ payloadJSON, payload }`) into the
 * payload value, with a stable semantic error when the JSON is malformed.
 *
 * Mirrors the codex extension's `unwrapNodeInvokePayload`: a non-record input is
 * returned as-is; a present non-blank `payloadJSON` is parsed with the parse
 * failure rewrapped into an `Error` whose `cause` keeps the original
 * `SyntaxError` (so low-level parser internals never leak to the client); an
 * empty/blank or missing `payloadJSON` falls back to the structured `payload`
 * field, then to the raw envelope.
 *
 * @param value The raw envelope returned by a paired-node invoke.
 * @param errorMessage Message for the rewrapped error; defaults to the shared
 *   catalog wording. Callers with a distinct owner (e.g. Codex CLI) may override
 *   it to name their boundary.
 */
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
