/**
 * Decodes HTML-entity escaped and escape-sequence encoded tool-call arguments in stream wrappers.
 */
import { decodeHtmlEntities } from "../../shared/html-entities.js";
import { visitObjectContentBlocks } from "../../shared/message-content-blocks.js";
import type { StreamFn } from "../runtime/index.js";
import type { MutableAssistantMessageEventStream } from "../stream-compat.js";

/**
 * Decodes HTML entities inside streamed tool-call arguments before downstream execution.
 *
 * Some providers HTML-escape JSON-ish argument strings in tool-call content blocks; this wrapper
 * repairs only arguments, preserving user-facing assistant text exactly as emitted.
 */
/** Recursively decodes HTML entities in string leaves of an object graph. */
function decodeHtmlEntitiesInObject(value: unknown): unknown {
  if (typeof value === "string") {
    return decodeHtmlEntities(value);
  }
  if (Array.isArray(value)) {
    return value.map(decodeHtmlEntitiesInObject);
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = decodeHtmlEntitiesInObject(entry);
    }
    return result;
  }
  return value;
}

const decodedToolCallArguments = new WeakSet<object>();

function decodeToolCallArgumentsHtmlEntitiesInMessage(message: unknown): void {
  visitObjectContentBlocks(message, (block) => {
    const typedBlock = block as { type?: unknown; arguments?: unknown };
    if (
      typedBlock.type !== "toolCall" ||
      typeof typedBlock.arguments !== "object" ||
      !typedBlock.arguments
    ) {
      return;
    }
    if (decodedToolCallArguments.has(typedBlock.arguments)) {
      return;
    }
    const decoded = decodeHtmlEntitiesInObject(typedBlock.arguments) as object;
    decodedToolCallArguments.add(decoded);
    typedBlock.arguments = decoded;
  });
}

function wrapStreamMessageObjects(
  stream: MutableAssistantMessageEventStream,
  transformMessage: (message: unknown) => void,
): MutableAssistantMessageEventStream {
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    transformMessage(message);
    return message;
  };

  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  // Patch both final result and streamed partial/message events. Tool execution can consume either
  // path depending on provider wrapper shape, so one-sided decoding would leave escaped args live.
  (stream as { [Symbol.asyncIterator]: typeof originalAsyncIterator })[Symbol.asyncIterator] =
    function () {
      const iterator = originalAsyncIterator();
      return {
        async next() {
          const result = await iterator.next();
          if (!result.done && result.value && typeof result.value === "object") {
            const event = result.value as { partial?: unknown; message?: unknown };
            transformMessage(event.partial);
            transformMessage(event.message);
          }
          return result;
        },
        async return(value?: unknown) {
          return iterator.return?.(value) ?? { done: true as const, value: undefined };
        },
        async throw(error?: unknown) {
          return iterator.throw?.(error) ?? { done: true as const, value: undefined };
        },
      };
    };
  return stream;
}

/** Wraps a stream function so tool-call arguments are decoded before consumers inspect them. */
export function createHtmlEntityToolCallArgumentDecodingWrapper(baseStreamFn: StreamFn): StreamFn {
  return (model, context, options) => {
    const maybeStream = baseStreamFn(model, context, options);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStreamMessageObjects(stream, decodeToolCallArgumentsHtmlEntitiesInMessage),
      );
    }
    return wrapStreamMessageObjects(maybeStream, decodeToolCallArgumentsHtmlEntitiesInMessage);
  };
}

// ---------------------------------------------------------------------------
// Escape-sequence decoding for Volcengine Deepseek models
// ---------------------------------------------------------------------------

/**
 * Normalizes escape sequences (\n, \t, \r) in a string value.
 *
 * Uses a conservative heuristic to avoid corrupting legitimate content:
 * - Requires 2+ `\n` occurrences (single `\n` is likely a Windows path like `C:\Work\nssm`)
 * - Skips when real newlines already exist (already-correct content preserved)
 * - Single-pass state machine, no sentinel character (zero collision risk)
 */
function normalizeEscapeSequencesInLeaf(value: string): string {
  // Heuristic gate: only convert when \n appears without real newlines,
  // and at least twice (avoid Windows path false positives).
  if (!value.includes("\\n") || value.includes("\n")) {
    return value;
  }
  if (value.split("\\n").length < 3) {
    return value;
  }

  // Single-pass state machine: \\ → \, \n → newline, \t → tab, \r → CR.
  // Double-backslash case (\\n): the first \\ outputs a backslash, then n stays literal.
  let result = "";
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "\\" && i + 1 < value.length) {
      if (value[i + 1] === "\\") {
        result += "\\";
        i++;
      } else if (value[i + 1] === "n") {
        result += "\n";
        i++;
      } else if (value[i + 1] === "t") {
        result += "\t";
        i++;
      } else if (value[i + 1] === "r") {
        result += "\r";
        i++;
      } else {
        result += value[i];
      }
    } else {
      result += value[i];
    }
  }
  return result;
}

const normalizedWriteToolContent = new WeakSet<object>();

/**
 * Applies escape-sequence normalization only to the `content` field of `write` tool calls,
 * preserving all other tool arguments (shell commands, search queries, regex patterns, etc.)
 * completely unchanged.
 */
function normalizeWriteToolEscapeSequencesInMessage(message: unknown): void {
  visitObjectContentBlocks(message, (block) => {
    const typedBlock = block as {
      type?: unknown;
      name?: unknown;
      arguments?: Record<string, unknown>;
    };
    if (
      typedBlock.type !== "toolCall" ||
      typedBlock.name !== "write" ||
      typeof typedBlock.arguments !== "object" ||
      !typedBlock.arguments
    ) {
      return;
    }
    if (normalizedWriteToolContent.has(typedBlock.arguments)) {
      return;
    }
    const content = typedBlock.arguments.content;
    if (typeof content === "string") {
      const normalized = normalizeEscapeSequencesInLeaf(content);
      if (normalized !== content) {
        typedBlock.arguments.content = normalized;
      }
    }
    normalizedWriteToolContent.add(typedBlock.arguments);
  });
}

/**
 * Wraps a stream function so escape sequences in write-tool `content` arguments
 * are normalized for Volcengine Deepseek models.
 *
 * Only affects the `content` field of `write` tool calls — other tools and
 * fields pass through unchanged.
 */
export function createEscapeSequenceStreamWrapper(baseStreamFn: StreamFn): StreamFn {
  return (model, context, options) => {
    const maybeStream = baseStreamFn(model, context, options);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStreamMessageObjects(stream, normalizeWriteToolEscapeSequencesInMessage),
      );
    }
    return wrapStreamMessageObjects(maybeStream, normalizeWriteToolEscapeSequencesInMessage);
  };
}
