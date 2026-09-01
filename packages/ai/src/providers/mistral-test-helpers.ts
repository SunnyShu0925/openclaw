import { toolCallFromJSON, type ToolCall } from "@mistralai/mistralai/models/components";
import type { Context, Model } from "../types.js";

export function makeMistralModel(): Model<"mistral-conversations"> {
  return {
    id: "mistral-large-latest",
    name: "Mistral Large",
    api: "mistral-conversations",
    provider: "mistral",
    baseUrl: "https://api.mistral.ai",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

export const mistralTestContext = {
  messages: [{ role: "user", content: "hello", timestamp: 0 }],
} satisfies Context;

export function makeHealthyTool(
  parameters: Record<string, unknown> = { type: "object", properties: {} },
) {
  return {
    name: "healthy_tool",
    description: "healthy tool",
    parameters,
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}

export function makeUnreadableParameterTool() {
  const tool = {
    name: "broken_tool",
    description: "broken tool",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "broken" }] }),
  };
  Object.defineProperty(tool, "parameters", {
    enumerable: true,
    get() {
      throw new Error("fuzzplugin parameters getter exploded");
    },
  });
  return tool;
}

export function makeUnreadableNameTool() {
  const tool = makeHealthyTool();
  Object.defineProperty(tool, "name", {
    enumerable: true,
    get() {
      throw new Error("fuzzplugin name getter exploded");
    },
  });
  return tool;
}

export function parseMistralToolCall(value: unknown): ToolCall {
  const parsed = toolCallFromJSON(JSON.stringify(value));
  if (!parsed.ok) {
    throw new Error("Mistral SDK failed to parse tool-call fixture");
  }
  return parsed.value;
}

export function mistralToolStream(responseId: string, ...chunks: ToolCall[][]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const toolCalls of chunks) {
        yield {
          data: {
            id: responseId,
            model: "mistral-large-latest",
            choices: [
              {
                finishReason: "tool_calls",
                delta: { content: null, toolCalls },
              },
            ],
          },
        };
      }
    },
  };
}

export function makeMistralToolResultContext(
  toolName: string,
  content: unknown[],
  options: { toolCallId?: string; includeUser?: boolean; includeToolResultName?: boolean } = {},
): Context {
  const toolCallId = options.toolCallId ?? "tool_1";
  return {
    messages: [
      ...(options.includeUser === false
        ? []
        : [{ ...mistralTestContext.messages[0], timestamp: 1 }]),
      {
        role: "assistant",
        provider: "mistral",
        api: "mistral-conversations",
        model: "mistral-large-latest",
        stopReason: "toolUse",
        timestamp: 0,
        content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId,
        ...(options.includeToolResultName ? { toolName } : {}),
        content,
        isError: false,
        timestamp: 0,
      },
    ],
  } as unknown as Context;
}

export function requireMistralFixtureValue<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Mistral fixture is missing an expected value");
  }
  return value;
}

export interface MistralMockState {
  configs: unknown[];
  payloads: unknown[];
  requestOptions: unknown[];
  randomUUIDs: string[];
  requestThroughHttpClient: boolean;
  streamError: unknown;
  streamResult: unknown;
}

export function getMistralMockState(): MistralMockState {
  const key = "__mistralMockState";
  const g = globalThis as Record<string, unknown>;
  const existing = g[key] as MistralMockState | undefined;
  if (existing) {
    return existing;
  }
  const fresh: MistralMockState = {
    configs: [],
    payloads: [],
    requestOptions: [],
    randomUUIDs: [],
    requestThroughHttpClient: false,
    streamError: new Error("stop before network"),
    streamResult: undefined,
  };
  g[key] = fresh;
  return fresh;
}

export function makeMistralTextStream(
  responseId: string,
  content: string,
  finishReason = "stop",
  extra?: { cancel?: () => Promise<void> },
) {
  const iter = {
    async *[Symbol.asyncIterator]() {
      yield {
        data: {
          id: responseId,
          model: "mistral-large-latest",
          choices: [{ finishReason, delta: { content } }],
        },
      };
    },
  };
  if (extra?.cancel) {
    return { ...iter, cancel: extra.cancel };
  }
  return iter;
}

export function resetMistralMockState(state: MistralMockState) {
  state.configs = [];
  state.payloads = [];
  state.requestOptions = [];
  state.randomUUIDs = [];
  state.requestThroughHttpClient = false;
  state.streamError = new Error("stop before network");
  state.streamResult = undefined;
}
