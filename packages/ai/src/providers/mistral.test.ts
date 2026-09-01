/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

import { toolCallFromJSON, type ToolCall } from "@mistralai/mistralai/models/components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import { withProviderAcceptanceObserver } from "../transports/transport-stream-shared.js";
import type { Context, Model } from "../types.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../utils/system-prompt-cache-boundary.js";

interface MistralMockState {
  configs: unknown[];
  payloads: unknown[];
  requestOptions: unknown[];
  randomUUIDs: string[];
  requestThroughHttpClient: boolean;
  streamError: unknown;
  streamResult: unknown;
}

function getMistralMockState(): MistralMockState {
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

const mistralMockState = getMistralMockState();

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    randomUUID: () => mistralMockState.randomUUIDs.shift() ?? actual.randomUUID(),
  };
});

vi.mock("@mistralai/mistralai", async () => {
  const actual =
    await vi.importActual<typeof import("@mistralai/mistralai")>("@mistralai/mistralai");
  return {
    ...actual,
    Mistral: class MockMistral {
      private readonly config: unknown;

      constructor(config: unknown) {
        this.config = config;
        mistralMockState.configs.push(config);
      }

      chat = {
        stream: vi.fn(async (payload: unknown, requestOptions: unknown) => {
          mistralMockState.payloads.push(payload);
          mistralMockState.requestOptions.push(requestOptions);
          if (mistralMockState.requestThroughHttpClient) {
            const httpClient = (
              this.config as {
                httpClient?: { request(request: Request): Promise<Response> };
              }
            ).httpClient;
            const response = await httpClient?.request(new Request("https://api.mistral.ai/chat"));
            if (response && !response.ok) {
              throw Object.assign(new Error(`Mistral HTTP ${response.status}`), {
                statusCode: response.status,
              });
            }
          }
          if (mistralMockState.streamResult !== undefined) {
            return mistralMockState.streamResult;
          }
          throw mistralMockState.streamError;
        }),
      };
    },
  };
});

import { streamMistral, streamSimpleMistral } from "./mistral.js";

function makeMistralModel(): Model<"mistral-conversations"> {
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

const context = {
  messages: [{ role: "user", content: "hello", timestamp: 0 }],
} satisfies Context;

function makeUnreadableParameterTool() {
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

function makeUnreadableNameTool() {
  const tool = makeHealthyTool();
  Object.defineProperty(tool, "name", {
    enumerable: true,
    get() {
      throw new Error("fuzzplugin name getter exploded");
    },
  });
  return tool;
}

function makeHealthyTool(parameters: Record<string, unknown> = { type: "object", properties: {} }) {
  return {
    name: "healthy_tool",
    description: "healthy tool",
    parameters,
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}

function parseMistralToolCall(value: unknown): ToolCall {
  const parsed = toolCallFromJSON(JSON.stringify(value));
  if (!parsed.ok) {
    throw new Error("Mistral SDK failed to parse tool-call fixture");
  }
  return parsed.value;
}

function requireMistralFixtureValue<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Mistral fixture is missing an expected value");
  }
  return value;
}

function mistralToolStream(responseId: string, ...chunks: ToolCall[][]) {
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

type MistralTestOptions = NonNullable<Parameters<typeof streamMistral>[2]>;
type SimpleMistralTestOptions = NonNullable<Parameters<typeof streamSimpleMistral>[2]>;

function runMistralFixture(
  testContext: Context = context,
  options: MistralTestOptions = {},
  testModel = makeMistralModel(),
) {
  return streamMistral(testModel, testContext, {
    apiKey: "sk-mistral-provider",
    ...options,
  }).result();
}

function runSimpleMistralFixture(
  testContext: Context = context,
  options: SimpleMistralTestOptions = {},
  testModel = makeMistralModel(),
) {
  return streamSimpleMistral(testModel, testContext, {
    apiKey: "sk-mistral-provider",
    ...options,
  }).result();
}

async function runMistralToolFixture(
  responseId: string,
  rawChunks: unknown[][],
  randomUUID?: string,
) {
  if (randomUUID) {
    mistralMockState.randomUUIDs = [randomUUID];
  }
  const parsedChunks = rawChunks.map((chunk) => chunk.map(parseMistralToolCall));
  mistralMockState.streamResult = mistralToolStream(responseId, ...parsedChunks);
  const result = await runMistralFixture();
  return {
    result,
    parsedChunks,
    toolCalls: result.content.filter((block) => block.type === "toolCall"),
  };
}

function makeMistralToolResultContext(
  toolName: string,
  content: unknown[],
  options: { toolCallId?: string; includeUser?: boolean; includeToolResultName?: boolean } = {},
): Context {
  const toolCallId = options.toolCallId ?? "tool_1";
  return {
    messages: [
      ...(options.includeUser === false
        ? []
        : [{ ...requireMistralFixtureValue(context.messages[0]), timestamp: 1 }]),
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

describe("Mistral provider", () => {
  beforeEach(() => {
    mistralMockState.configs = [];
    mistralMockState.payloads = [];
    mistralMockState.requestOptions = [];
    mistralMockState.randomUUIDs = [];
    mistralMockState.requestThroughHttpClient = false;
    mistralMockState.streamError = new Error("stop before network");
    mistralMockState.streamResult = undefined;
  });

  afterEach(() => {
    configureAiTransportHost({});
  });

  it("reports the real HTTP response captured by the Mistral HTTPClient hook", async () => {
    mistralMockState.requestThroughHttpClient = true;
    mistralMockState.streamResult = {
      async *[Symbol.asyncIterator]() {
        yield {
          data: {
            id: "resp-http-ack",
            model: "mistral-large-latest",
            choices: [{ finishReason: "stop", delta: { content: "ok" } }],
          },
        };
      },
    };
    const hostFetch = vi.fn<typeof fetch>(
      async () =>
        new Response("stream", {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "x-mistral-request-id": "req-1",
          },
        }),
    );
    configureAiTransportHost({ buildModelFetch: () => hostFetch });
    const acceptanceObserver = vi.fn();
    const onResponse = vi.fn();
    const options = withProviderAcceptanceObserver({ onResponse }, acceptanceObserver);

    const result = await runSimpleMistralFixture(context, options);

    expect(result.stopReason).toBe("stop");
    expect(acceptanceObserver).toHaveBeenCalledWith({
      kind: "http_response",
      status: 200,
      headers: expect.objectContaining({
        "content-type": "text/event-stream",
        "x-mistral-request-id": "req-1",
      }),
    });
    expect(onResponse).toHaveBeenCalledWith(
      {
        status: 200,
        headers: expect.objectContaining({ "x-mistral-request-id": "req-1" }),
      },
      expect.objectContaining({ provider: "mistral" }),
    );
    expect(hostFetch).toHaveBeenCalledOnce();
  });

  it("cancels an unread Mistral stream when acceptance observation fails", async () => {
    mistralMockState.requestThroughHttpClient = true;
    const cancel = vi.fn(async () => undefined);
    mistralMockState.streamResult = {
      cancel,
      async *[Symbol.asyncIterator]() {
        yield {
          data: {
            id: "resp-http-ack",
            model: "mistral-large-latest",
            choices: [{ finishReason: "stop", delta: { content: "ok" } }],
          },
        };
      },
    };
    configureAiTransportHost({
      buildModelFetch: () => async () => new Response("stream", { status: 200 }),
    });
    const hookError = new Error("acceptance observer failed");
    const options = withProviderAcceptanceObserver({}, () => {
      throw hookError;
    });

    const result = await runSimpleMistralFixture(context, options);

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "acceptance observer failed",
    });
    expect(cancel).toHaveBeenCalledWith(hookError);
  });

  it("reports a rejected HTTP response without marking it accepted", async () => {
    mistralMockState.requestThroughHttpClient = true;
    const hostFetch = vi.fn<typeof fetch>(
      async () =>
        new Response("rate limited", {
          status: 429,
          headers: { "x-mistral-request-id": "req-rejected" },
        }),
    );
    configureAiTransportHost({ buildModelFetch: () => hostFetch });
    const acceptanceObserver = vi.fn();
    const onResponse = vi.fn();
    const options = withProviderAcceptanceObserver({ onResponse }, acceptanceObserver);

    const result = await runSimpleMistralFixture(context, options);

    expect(result.stopReason).toBe("error");
    expect(acceptanceObserver).not.toHaveBeenCalled();
    expect(onResponse).toHaveBeenCalledWith(
      {
        status: 429,
        headers: expect.objectContaining({ "x-mistral-request-id": "req-rejected" }),
      },
      expect.objectContaining({ provider: "mistral" }),
    );
    expect(hostFetch).toHaveBeenCalledOnce();
  });

  it("does not report acceptance when SDK stream setup fails", async () => {
    const acceptanceObserver = vi.fn();
    const options = withProviderAcceptanceObserver({}, acceptanceObserver);

    const result = await runSimpleMistralFixture(context, options);

    expect(result.stopReason).toBe("error");
    expect(acceptanceObserver).not.toHaveBeenCalled();
  });

  it("forwards simple stop sequences to Mistral stop", async () => {
    const result = await runSimpleMistralFixture(context, {
      stop: ["STOP"],
    });

    expect(result.stopReason).toBe("error");
    expect((mistralMockState.payloads[0] as { stop?: unknown }).stop).toEqual(["STOP"]);
  });

  it("preserves Mistral messages while keeping error bodies UTF-16 safe and bounded", async () => {
    const prefix = "a".repeat(3_999);
    mistralMockState.streamError = Object.assign(new Error("invalid request"), {
      statusCode: 400,
      body: `${prefix}😀tail`,
    });

    const result = await runMistralFixture();

    expect(result.errorMessage).toBe("invalid request");
    expect(result.errorBody).toBe(`${prefix.slice(0, 500)}... [truncated]`);
  });

  it("routes the Mistral HTTPClient through the host guarded fetch", async () => {
    const hostFetch = vi.fn<typeof fetch>(async () => new Response("guarded"));
    configureAiTransportHost({ buildModelFetch: () => hostFetch });

    await runMistralFixture(context, { apiKey: "sentinel-key" });

    const config = mistralMockState.configs[0] as {
      apiKey?: string;
      httpClient?: { request(request: Request): Promise<Response> };
    };
    expect(config.apiKey).toBe("sentinel-key");
    const response = await config.httpClient?.request(new Request("https://api.mistral.ai/chat"));
    expect(await response?.text()).toBe("guarded");
    expect(hostFetch).toHaveBeenCalledTimes(1);
  });

  it("uses reasoning effort for Mistral Medium 3.5", async () => {
    const result = await runSimpleMistralFixture(
      context,
      { reasoning: "high" },
      {
        ...makeMistralModel(),
        id: "mistral-medium-3-5",
        name: "Mistral Medium 3.5",
        reasoning: true,
      },
    );
    const payload = mistralMockState.payloads[0] as Record<string, unknown>;

    expect(result.stopReason).toBe("error");
    expect(payload.reasoningEffort).toBe("high");
    expect(payload).not.toHaveProperty("promptMode");
  });

  it("skips unreadable tool fields while preserving healthy Mistral tools", async () => {
    const healthyParameters = { type: "object", properties: { query: { type: "string" } } };
    const result = await runMistralFixture({
      ...context,
      tools: [
        makeUnreadableNameTool(),
        makeUnreadableParameterTool(),
        makeHealthyTool(healthyParameters),
      ] as never,
    });

    expect(result.stopReason).toBe("error");
    expect((mistralMockState.payloads[0] as { tools?: unknown[] }).tools).toEqual([
      {
        type: "function",
        function: {
          name: "healthy_tool",
          description: "healthy tool",
          parameters: healthyParameters,
          strict: false,
        },
      },
    ]);
  });

  it("keeps request bytes stable across equivalent tool input order", async () => {
    const tools = [
      { ...makeHealthyTool(), name: "zeta_tool", description: "Zeta tool" },
      { ...makeHealthyTool(), name: "alpha_tool", description: "Alpha tool" },
    ];

    await runMistralFixture({ ...context, tools } as never);
    await runMistralFixture({ ...context, tools: tools.toReversed() } as never);

    expect(JSON.stringify(mistralMockState.payloads[0])).toBe(
      JSON.stringify(mistralMockState.payloads[1]),
    );
    expect(
      (mistralMockState.payloads[0] as { tools: Array<{ function: { name: string } }> }).tools.map(
        (tool) => tool.function.name,
      ),
    ).toEqual(["alpha_tool", "zeta_tool"]);
  });

  it("omits tools and automatic tool choice when every schema is unreadable", async () => {
    const result = await runMistralFixture(
      {
        ...context,
        tools: [makeUnreadableParameterTool()] as never,
      },
      {
        toolChoice: "auto",
      },
    );
    const payload = mistralMockState.payloads[0] as Record<string, unknown>;

    expect(result.stopReason).toBe("error");
    expect(payload).not.toHaveProperty("tools");
    expect(payload).not.toHaveProperty("toolChoice");
  });

  it("keeps omitted streamed tool ids stable within a response and unique across responses", async () => {
    mistralMockState.randomUUIDs = [
      "00000000-0000-4000-8000-000000429244",
      "00000000-0000-4000-8000-000000429245",
    ];
    const responseIds: string[][] = [];
    for (const responseId of ["response-a", "response-b"]) {
      mistralMockState.streamResult = mistralToolStream(
        responseId,
        [
          {
            index: 0,
            id: "null",
            function: { name: "computer", arguments: '{"step"' },
          },
          {
            index: 1,
            id: responseId === "response-a" ? "explicitA" : "explicitB",
            function: { name: "computer", arguments: '{"other"' },
          },
        ],
        [
          { index: 0, function: { name: "", arguments: ":1}" } },
          { index: 1, function: { name: "", arguments: ":true}" } },
        ],
      );
      const result = await runMistralFixture();
      const toolCalls = result.content.filter((block) => block.type === "toolCall");
      expect(toolCalls).toHaveLength(2);
      expect(toolCalls[0]?.arguments).toEqual({ step: 1 });
      expect(toolCalls[1]?.arguments).toEqual({ other: true });
      responseIds.push(toolCalls.map((toolCall) => toolCall.id));
    }

    expect(responseIds.flat().every((id) => /^[a-zA-Z0-9]{9}$/.test(id))).toBe(true);
    expect(responseIds[0]?.[1]).toBe("explicitA");
    expect(responseIds[1]?.[1]).toBe("explicitB");
    expect(responseIds[1]?.[0]).not.toBe(responseIds[0]?.[0]);
  });

  it("keeps explicit streamed tool calls distinct when index is omitted", async () => {
    const { parsedChunks, toolCalls } = await runMistralToolFixture("response-unindexed", [
      [
        { id: "explicitA", function: { name: "first_tool", arguments: '{"value"' } },
        { id: "explicitB", function: { name: "second_tool", arguments: '{"value"' } },
      ],
      [
        { function: { name: "first_tool", arguments: ":1}" } },
        { function: { name: "second_tool", arguments: ":2}" } },
      ],
    ]);
    const firstCall = requireMistralFixtureValue(parsedChunks[0]?.[0]);
    const secondCall = requireMistralFixtureValue(parsedChunks[0]?.[1]);
    // The SDK defaults an omitted wire index to zero. Explicit provider ids
    // must still win over that ambiguous compatibility default.
    expect(firstCall.index).toBe(0);
    expect(secondCall.index).toBe(0);

    expect(toolCalls).toMatchObject([
      { id: "explicitA", name: "first_tool", arguments: { value: 1 } },
      { id: "explicitB", name: "second_tool", arguments: { value: 2 } },
    ]);
  });

  it("keeps missing-id streamed tool calls distinct when index is omitted", async () => {
    const { parsedChunks, toolCalls } = await runMistralToolFixture(
      "response-unidentified",
      [
        [
          { function: { name: "first_tool", arguments: '{"value"' } },
          { index: 1, function: { name: "second_tool", arguments: '{"value"' } },
        ],
        [
          { function: { name: "first_tool", arguments: ":1}" } },
          { function: { name: "second_tool", arguments: ":2}" } },
        ],
      ],
      "00000000-0000-4000-8000-000000429246",
    );
    const firstCall = requireMistralFixtureValue(parsedChunks[0]?.[0]);
    const secondCall = requireMistralFixtureValue(parsedChunks[0]?.[1]);
    const secondContinuation = requireMistralFixtureValue(parsedChunks[1]?.[1]);
    expect(firstCall).toMatchObject({ id: "null", index: 0 });
    expect(secondCall).toMatchObject({ id: "null", index: 1 });
    expect(secondContinuation).toMatchObject({ id: "null", index: 0 });

    expect(toolCalls).toMatchObject([
      { name: "first_tool", arguments: { value: 1 } },
      { name: "second_tool", arguments: { value: 2 } },
    ]);
    const toolCallIds = toolCalls.map((toolCall) => toolCall.id);
    expect(toolCallIds).toHaveLength(2);
    expect(new Set(toolCallIds).size).toBe(2);
    expect(toolCallIds.every((id) => /^[a-zA-Z0-9]{9}$/.test(id))).toBe(true);
  });

  it("routes an asymmetric omitted-index continuation by its persistent function name", async () => {
    const { parsedChunks, toolCalls } = await runMistralToolFixture(
      "response-asymmetric-unindexed",
      [
        [
          { function: { name: "first_tool", arguments: '{"value":1}' } },
          { index: 1, function: { name: "second_tool", arguments: '{"value"' } },
        ],
        [{ function: { name: "second_tool", arguments: ":2}" } }],
      ],
      "00000000-0000-4000-8000-000000429247",
    );
    const firstCall = requireMistralFixtureValue(parsedChunks[0]?.[0]);
    const secondCall = requireMistralFixtureValue(parsedChunks[0]?.[1]);
    const secondContinuation = requireMistralFixtureValue(parsedChunks[1]?.[0]);
    expect(firstCall).toMatchObject({ id: "null", index: 0 });
    expect(secondCall).toMatchObject({ id: "null", index: 1 });
    // The SDK defaults the omitted continuation index to zero; the persistent
    // function name must still bind it back to the index-1 call.
    expect(secondContinuation).toMatchObject({ id: "null", index: 0 });

    expect(toolCalls).toMatchObject([
      { name: "first_tool", arguments: { value: 1 } },
      { name: "second_tool", arguments: { value: 2 } },
    ]);
  });

  it("rejects an ambiguous idless and nameless omitted-index continuation", async () => {
    const { result } = await runMistralToolFixture(
      "response-ambiguous-unindexed",
      [
        [
          { function: { name: "first_tool", arguments: '{"value"' } },
          { function: { name: "second_tool", arguments: '{"value"' } },
        ],
        [{ function: { name: "", arguments: ":2}" } }],
      ],
      "00000000-0000-4000-8000-000000429248",
    );

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("tool-call continuation is ambiguous");
  });

  it("keeps same-name omitted-index siblings distinct and rejects their ambiguous continuation", async () => {
    const { result, toolCalls } = await runMistralToolFixture(
      "response-same-name-unindexed",
      [
        [
          { function: { name: "computer", arguments: '{"step"' } },
          { function: { name: "computer", arguments: '{"step"' } },
        ],
        [{ function: { name: "computer", arguments: ":2}" } }],
      ],
      "00000000-0000-4000-8000-000000429249",
    );

    expect(toolCalls).toHaveLength(0);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("tool-call continuation is ambiguous");
  });

  it("keeps a later same-name call distinct when it has a nonzero index", async () => {
    mistralMockState.randomUUIDs = ["00000000-0000-4000-8000-000000429250"];
    const firstCall = parseMistralToolCall({
      index: 0,
      function: { name: "computer", arguments: '{"step":1}' },
    });
    const secondCall = parseMistralToolCall({
      index: 1,
      function: { name: "computer", arguments: '{"step":2}' },
    });
    mistralMockState.streamResult = {
      async *[Symbol.asyncIterator]() {
        for (const [id, toolCall] of [firstCall, secondCall].entries()) {
          yield* mistralToolStream(`response-same-name-indexed-${id}`, [toolCall]);
        }
      },
    };

    const result = await runMistralFixture();
    const toolCalls = result.content.filter((block) => block.type === "toolCall");

    expect(toolCalls).toMatchObject([
      { name: "computer", arguments: { step: 1 } },
      { name: "computer", arguments: { step: 2 } },
    ]);
    expect(new Set(toolCalls.map((toolCall) => toolCall.id)).size).toBe(2);
  });

  it("fails locally when a pinned Mistral tool choice is skipped", async () => {
    const result = await runMistralFixture(
      {
        ...context,
        tools: [makeUnreadableParameterTool(), makeHealthyTool()] as never,
      },
      {
        toolChoice: { type: "function", function: { name: "broken_tool" } },
      },
    );

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(
      'Mistral tool_choice requested unavailable tool "broken_tool"',
    );
    expect(mistralMockState.payloads).toHaveLength(0);
  });

  it("validates and emits one snapshot of a pinned Mistral tool name", async () => {
    let nameReads = 0;
    const result = await runMistralFixture(
      {
        ...context,
        tools: [makeHealthyTool()] as never,
      },
      {
        toolChoice: {
          type: "function",
          function: {
            get name() {
              nameReads += 1;
              return nameReads === 1 ? "healthy_tool" : "broken_tool";
            },
          },
        },
      },
    );

    expect(result.stopReason).toBe("error");
    expect(nameReads).toBe(1);
    expect((mistralMockState.payloads[0] as { toolChoice?: unknown }).toolChoice).toEqual({
      type: "function",
      function: { name: "healthy_tool" },
    });
  });

  it("strips the internal cache boundary marker from the system message", async () => {
    await runSimpleMistralFixture({
      systemPrompt: `Stable${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic`,
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
    });

    const payload = mistralMockState.payloads[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemMessage = payload.messages.find((message) => message.role === "system");
    expect(systemMessage?.content).toBe("Stable\nDynamic");
    expect(JSON.stringify(payload)).not.toContain("OPENCLAW_CACHE_BOUNDARY");
  });

  it("uses prompt cache affinity unless caching is disabled", async () => {
    for (const cacheRetention of [undefined, "none"] as const) {
      mistralMockState.payloads = [];
      mistralMockState.requestOptions = [];
      await runSimpleMistralFixture(context, {
        apiKey: "fixture",
        sessionId: "session-affinity",
        promptCacheKey: "prompt-cache-key",
        ...(cacheRetention ? { cacheRetention } : {}),
      });

      const payload = mistralMockState.payloads[0] as { promptCacheKey?: string };
      const requestOptions = mistralMockState.requestOptions[0] as {
        headers?: Record<string, string>;
      };
      if (cacheRetention === "none") {
        expect(payload.promptCacheKey).toBeUndefined();
        expect(requestOptions.headers?.["x-affinity"]).toBeUndefined();
      } else {
        expect(payload.promptCacheKey).toBe("prompt-cache-key");
        expect(requestOptions.headers?.["x-affinity"]).toBe("session-affinity");
      }
    }
  });

  it("uses the session id as the prompt cache key when no dedicated key is supplied", async () => {
    await runSimpleMistralFixture(context, {
      apiKey: "fixture",
      sessionId: "session-cache-key",
    });

    expect((mistralMockState.payloads[0] as { promptCacheKey?: string }).promptCacheKey).toBe(
      "session-cache-key",
    );
  });

  it.each([
    ["SDK camel case", { promptTokensDetails: { cachedTokens: 64 } }],
    ["wire snake case", { prompt_tokens_details: { cached_tokens: 64 } }],
  ])("accounts for cached prompt tokens from %s usage", async (_label, cacheUsage) => {
    mistralMockState.streamResult = {
      async *[Symbol.asyncIterator]() {
        yield {
          data: {
            id: "response-cache-usage",
            model: "mistral-small-latest",
            usage: {
              promptTokens: 100,
              completionTokens: 10,
              totalTokens: 110,
              ...cacheUsage,
            },
            choices: [
              {
                finishReason: "stop",
                delta: { content: "ok", toolCalls: [] },
              },
            ],
          },
        };
      },
    };

    const result = await runMistralFixture(context, { apiKey: "fixture" });

    expect(result.usage).toMatchObject({
      input: 36,
      output: 10,
      cacheRead: 64,
      cacheWrite: 0,
      totalTokens: 110,
    });
    expect(result.responseId).toBe("response-cache-usage");
    expect(result.responseModel).toBe("mistral-small-latest");
  });

  it("omits responseModel when streamed model matches the requested id", async () => {
    mistralMockState.streamResult = {
      async *[Symbol.asyncIterator]() {
        yield {
          data: {
            id: "response-same-model",
            model: "mistral-large-latest",
            choices: [{ finishReason: "stop", delta: { content: "ok" } }],
          },
        };
      },
    };

    const result = await runMistralFixture(context, { apiKey: "fixture" });

    expect(result.responseId).toBe("response-same-model");
    expect(result).not.toHaveProperty("responseModel");
  });

  it("preserves tool-result boundary whitespace in the request payload", async () => {
    const testContext = makeMistralToolResultContext("read_file", [
      { type: "text", text: "  indented\n" },
    ]);

    await runMistralFixture(testContext);

    const payload = mistralMockState.payloads[0] as {
      messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
    };
    const toolMessage = payload.messages.find((message) => message.role === "tool");
    const toolContent = Array.isArray(toolMessage?.content) ? toolMessage.content : [];
    const textBlock = toolContent.find((block) => block.type === "text");
    expect(textBlock?.text).toBe("  indented\n");
  });

  it("serializes structured non-image blocks in tool results as JSON text", async () => {
    // Prove the host redaction port is applied to structured tool-result text.
    configureAiTransportHost({
      redactModelVisibleSecrets: <T>(value: T): T =>
        JSON.parse(JSON.stringify(value).replaceAll('"value"', '"***"')) as T,
    });
    const testContext = makeMistralToolResultContext("fetch", [
      {
        type: "resource",
        resource: {
          uri: "https://example.com/data.json",
          mimeType: "application/json",
          text: '{"key":"value"}',
        },
      },
    ]);

    await runMistralFixture(testContext);

    const payload = mistralMockState.payloads[0] as {
      messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
    };
    const toolMessage = payload.messages.find((message) => message.role === "tool");
    const toolContent = Array.isArray(toolMessage?.content) ? toolMessage.content : [];
    const textBlock = toolContent.find((block) => block.type === "text");
    expect(textBlock?.text).toEqual(expect.stringContaining('{"type":"resource"'));
    expect(textBlock?.text).toContain('{\\"key\\":\\"value\\"}');
  });

  it("does not emit image chunks or placeholders for payload-less tool media", async () => {
    const testContext = makeMistralToolResultContext(
      "screenshot",
      [{ type: "image", mimeType: "image/png", data: "" }],
      { toolCallId: "tool_husk", includeUser: false, includeToolResultName: true },
    );

    await runMistralFixture(
      testContext,
      { apiKey: "fake" },
      { ...makeMistralModel(), input: ["text", "image"] },
    );

    const payload = mistralMockState.payloads[0] as {
      messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
    };
    const toolMessage = payload.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toEqual([{ type: "text", text: "(no tool output)" }]);
    expect(JSON.stringify(toolMessage)).not.toContain("image_url");
    expect(JSON.stringify(toolMessage)).not.toContain("see attached image");
  });

  it("serializes structured-only tool results instead of empty fallback", async () => {
    const testContext = makeMistralToolResultContext("get_file", [
      {
        type: "resource_link",
        uri: "https://example.com/file.txt",
        name: "file.txt",
        mimeType: "text/plain",
        size: 100,
      },
    ]);

    await runMistralFixture(testContext);

    const payload = mistralMockState.payloads[0] as {
      messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
    };
    const toolMessage = payload.messages.find((message) => message.role === "tool");
    const toolContent = Array.isArray(toolMessage?.content) ? toolMessage.content : [];
    const textBlock = toolContent.find((block) => block.type === "text");
    // Structured blocks should provide the output, not an empty fallback
    expect(textBlock?.text).toEqual(expect.stringContaining('{"type":"resource_link"'));
    expect(textBlock?.text).not.toContain("(no tool output)");
  });
});
describe("Mistral provider — fragmented streamed function names", () => {
  beforeEach(() => {
    mistralMockState.configs = [];
    mistralMockState.payloads = [];
    mistralMockState.requestOptions = [];
    mistralMockState.randomUUIDs = [];
    mistralMockState.requestThroughHttpClient = false;
    mistralMockState.streamError = new Error("stop before network");
    mistralMockState.streamResult = undefined;
  });

  afterEach(() => {
    configureAiTransportHost({});
  });

  it("concatenates fragmented streamed function names on a stable-id continuation", async () => {
    const { toolCalls } = await runMistralToolFixture("response-fragmented-name", [
      [
        {
          id: "call_name",
          index: 0,
          function: { name: "get_", arguments: '{"city":' },
        },
      ],
      [
        {
          id: "call_name",
          index: 0,
          function: { name: "weather", arguments: '"Paris"}' },
        },
      ],
    ]);

    expect(toolCalls).toMatchObject([{ name: "get_weather", arguments: { city: "Paris" } }]);
  });

  it("concatenates fragmented streamed function names on a stable-id continuation without a wire index", async () => {
    // The SDK default-fills an omitted wire `index` to 0, which cannot be
    // distinguished from an explicit index 0 after parsing. Continuation by
    // index alone is therefore unsafe; a stable explicit id must carry the
    // fragment. See `keeps idless differently-named omitted-index calls distinct`.
    const { toolCalls } = await runMistralToolFixture("response-fragmented-name-id", [
      [
        {
          id: "call_name",
          function: { name: "get_", arguments: '{"city":' },
        },
      ],
      [
        {
          id: "call_name",
          function: { name: "weather", arguments: '"Paris"}' },
        },
      ],
    ]);

    expect(toolCalls).toMatchObject([{ name: "get_weather", arguments: { city: "Paris" } }]);
  });

  it("keeps idless differently-named omitted-index calls distinct", async () => {
    // Regression for the omitted-index sibling separation: when the wire omits
    // `index`, the SDK default-fills 0. Two such calls with different names must
    // stay distinct rather than collapsing the second into the first index-0
    // block (which would concatenate names and malformed the arguments).
    const { result, toolCalls } = await runMistralToolFixture(
      "response-idless-omitted-index-siblings",
      [
        [{ function: { name: "first_tool", arguments: '{"value":1}' } }],
        [{ function: { name: "second_tool", arguments: '{"value":2}' } }],
      ],
    );

    expect(result.stopReason).not.toBe("error");
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls.map((toolCall) => toolCall.name).toSorted()).toEqual([
      "first_tool",
      "second_tool",
    ]);
  });

  it("preserves one-shot function names without duplication", async () => {
    const { toolCalls } = await runMistralToolFixture("response-one-shot-name", [
      [
        {
          id: "call_name",
          index: 0,
          function: { name: "get_weather", arguments: '{"city":"Paris"}' },
        },
      ],
    ]);

    expect(toolCalls).toMatchObject([{ name: "get_weather", arguments: { city: "Paris" } }]);
  });

  it("does not alter the accumulated name when a continuation fragment is empty", async () => {
    const { toolCalls } = await runMistralToolFixture("response-empty-fragment", [
      [
        {
          id: "call_name",
          index: 0,
          function: { name: "get_weather", arguments: '{"city":' },
        },
      ],
      [
        {
          id: "call_name",
          index: 0,
          function: { name: "", arguments: '"Paris"}' },
        },
      ],
    ]);

    expect(toolCalls).toMatchObject([{ name: "get_weather", arguments: { city: "Paris" } }]);
  });

  it("keeps independently identified parallel fragmented names distinct", async () => {
    // Parallel fragmented names must be carried by stable explicit ids, since
    // an omitted wire index defaults to 0 and cannot safely distinguish siblings.
    const { toolCalls } = await runMistralToolFixture("response-parallel-fragmented", [
      [
        {
          id: "call_a",
          index: 0,
          function: { name: "get_", arguments: '{"a":' },
        },
        {
          id: "call_b",
          index: 1,
          function: { name: "set_", arguments: '{"b":' },
        },
      ],
      [
        {
          id: "call_a",
          index: 0,
          function: { name: "weather", arguments: "1}" },
        },
        {
          id: "call_b",
          index: 1,
          function: { name: "status", arguments: "2}" },
        },
      ],
    ]);

    expect(toolCalls).toMatchObject([
      { name: "get_weather", arguments: { a: 1 } },
      { name: "set_status", arguments: { b: 2 } },
    ]);
  });

  it("honors an explicit id when a continuation fragment equals another call's full name", async () => {
    // Call A fragments its name (get_ + weather) while call B already completed
    // with the full name "weather". A's continuation fragment "weather" is a
    // recorded name on block B, but the explicit id still selects block A. The
    // name-candidate intersection must not veto the authoritative explicit id.
    const { toolCalls } = await runMistralToolFixture("response-explicit-id-name-collision", [
      [
        {
          id: "call_a",
          index: 0,
          function: { name: "get_", arguments: '{"a":' },
        },
        {
          id: "call_b",
          index: 1,
          function: { name: "weather", arguments: '{"b":2}' },
        },
      ],
      [
        {
          id: "call_a",
          index: 0,
          function: { name: "weather", arguments: "1}" },
        },
      ],
    ]);

    expect(toolCalls).toMatchObject([
      { id: "call_a", name: "get_weather", arguments: { a: 1 } },
      { id: "call_b", name: "weather", arguments: { b: 2 } },
    ]);
  });

  it("treats a repeated stable-id whole name as idempotent, not concatenated", async () => {
    // A repeated whole name on the same explicit id (foo + foo) is idempotent
    // (=> foo), never concatenated into "foofoo" — a name no registered tool
    // will match. This mirrors main's pre-existing assignment contract for
    // same-name continuations and keeps the explicit-id arm aligned with the
    // idless arm. Genuine fragmentation uses distinct fragments
    // (get_ + weather), which still concatenates to "get_weather".
    const { toolCalls } = await runMistralToolFixture("response-repeated-fragment-name", [
      [
        {
          id: "call_name",
          index: 0,
          function: { name: "foo", arguments: '{"x":' },
        },
      ],
      [
        {
          id: "call_name",
          index: 0,
          function: { name: "foo", arguments: "1}" },
        },
      ],
    ]);

    expect(toolCalls).toMatchObject([{ name: "foo", arguments: { x: 1 } }]);
  });

  it("keeps an explicit-id name fragment from capturing a later idless same-name call", async () => {
    // An explicit-id call fragments get_ + weather. The "weather" fragment must
    // NOT become a durable name candidate, or a later idless "weather" call
    // (SDK-defaulted index zero, in a separate delta so it is not excluded by
    // the per-delta used-block set) could resolve to the explicit-id block,
    // overwrite its name, and merge both argument buffers. The idless call must
    // start its own block instead.
    const { toolCalls } = await runMistralToolFixture("response-fragment-alias-no-capture", [
      [
        {
          id: "call_a",
          index: 0,
          function: { name: "get_", arguments: '{"city":' },
        },
      ],
      [
        {
          id: "call_a",
          index: 0,
          function: { name: "weather", arguments: '"Paris"}' },
        },
      ],
      [{ index: 0, function: { name: "weather", arguments: '{"city":2}' } }],
    ]);

    expect(toolCalls).toMatchObject([
      { id: "call_a", name: "get_weather", arguments: { city: "Paris" } },
      { name: "weather", arguments: { city: 2 } },
    ]);
  });

  it("keeps an assembled full name from capturing a later idless call repeating the opening fragment", async () => {
    // An explicit-id call fragments get_ + weather into "get_weather". The
    // opening fragment "get_" was recorded as the block's durable name identity
    // at creation; once the full name is assembled, that stale fragment must be
    // replaced. Otherwise a later idless call named "get_" (SDK-defaulted index
    // zero, in its own delta) would resolve to this block via name-match and
    // merge both argument buffers. The sibling case above uses the tail
    // fragment "weather" (already excluded by the explicit-id guard); this one
    // covers the opening fragment, which the guard does not reach.
    const { toolCalls } = await runMistralToolFixture("response-assembled-name-alias", [
      [
        {
          id: "call_a",
          index: 1,
          function: { name: "get_", arguments: '{"city":' },
        },
      ],
      [
        {
          id: "call_a",
          index: 1,
          function: { name: "weather", arguments: '"Paris"}' },
        },
      ],
      [{ index: 0, function: { name: "get_", arguments: '{"city":2}' } }],
    ]);

    expect(toolCalls).toMatchObject([
      { id: "call_a", name: "get_weather", arguments: { city: "Paris" } },
      { name: "get_", arguments: { city: 2 } },
    ]);
  });

  it("refuses a differing whole name on a stable id when it cannot assemble a requested tool name", async () => {
    // Without a provider wire contract, a differing name on a stable id is an
    // identity collision (or a snapshot replacement), not a provable fragment.
    // Gate the append on the assembled name being a prefix of a requested tool
    // name: get_weather + read_file => "get_weatherread_file", which is a prefix
    // of no requested tool, so main's fail-closed refusal fires instead of
    // forwarding the first call's arguments under an unmatched name.
    const parsed = [
      [
        parseMistralToolCall({
          id: "call_x",
          index: 0,
          function: { name: "get_weather", arguments: '{"city":"Paris"}' },
        }),
      ],
      [
        parseMistralToolCall({
          id: "call_x",
          index: 0,
          function: { name: "read_file", arguments: "" },
        }),
      ],
    ];
    mistralMockState.streamResult = mistralToolStream("response-name-gate-collision", ...parsed);
    const result = await runMistralFixture({
      ...context,
      tools: [
        { ...makeHealthyTool(), name: "get_weather" },
        { ...makeHealthyTool(), name: "read_file" },
      ] as never,
    });

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(
      "Mistral streamed tool-call continuation changed function name; refusing to merge arguments",
    );
  });

  it("assembles a fragmented name when the concatenation is a prefix of a requested tool name", async () => {
    // Genuine fragments (get_ + weather) assemble toward a requested tool name
    // ("get_weather"), so the gate permits the append and the call completes.
    const parsed = [
      [
        parseMistralToolCall({
          id: "call_a",
          index: 0,
          function: { name: "get_", arguments: '{"city":' },
        }),
      ],
      [
        parseMistralToolCall({
          id: "call_a",
          index: 0,
          function: { name: "weather", arguments: '"Paris"}' },
        }),
      ],
    ];
    mistralMockState.streamResult = mistralToolStream("response-name-gate-fragment", ...parsed);
    const result = await runMistralFixture({
      ...context,
      tools: [{ ...makeHealthyTool(), name: "get_weather" }] as never,
    });
    const toolCalls = result.content.filter((block) => block.type === "toolCall");

    expect(toolCalls).toMatchObject([{ name: "get_weather", arguments: { city: "Paris" } }]);
  });

  it("keeps an assembled full name from capturing a later idless call repeating the assembled name", async () => {
    // After call_a assembles get_ + weather into "get_weather", the assembled
    // full name is in the identity set. A later idless index-0 call also named
    // "get_weather" (the *full* assembled name, not the opening fragment) must
    // not resolve to call_a via the unique-name shortcut and merge argument
    // buffers. The assembled block withdraws from name-match; the idless call
    // starts its own block. (Distinct from the opening-fragment case above: that
    // one repeats "get_", this one repeats the assembled "get_weather".)
    const parsed = [
      [
        parseMistralToolCall({
          id: "call_a",
          index: 1,
          function: { name: "get_", arguments: '{"city":' },
        }),
      ],
      [
        parseMistralToolCall({
          id: "call_a",
          index: 1,
          function: { name: "weather", arguments: '"Paris"}' },
        }),
      ],
      [
        parseMistralToolCall({
          index: 0,
          function: { name: "get_weather", arguments: '{"city":2}' },
        }),
      ],
    ];
    mistralMockState.streamResult = mistralToolStream(
      "response-assembled-name-no-capture",
      ...parsed,
    );
    const result = await runMistralFixture({
      ...context,
      tools: [
        { ...makeHealthyTool(), name: "get_weather" },
        { ...makeHealthyTool(), name: "other_tool" },
      ] as never,
    });
    const toolCalls = result.content.filter((block) => block.type === "toolCall");

    expect(toolCalls).toMatchObject([
      { id: "call_a", name: "get_weather", arguments: { city: "Paris" } },
      { name: "get_weather", arguments: { city: 2 } },
    ]);
  });

  it("gates the append on the tool names actually sent after onPayload replaces them", async () => {
    // onPayload is contractually allowed to replace the payload, including its
    // tools. The assembly gate must use the tool names actually sent, not the
    // set computed before onPayload. Here context declares both get_weather and
    // get_weatherread_file, but onPayload drops get_weatherread_file. A
    // differing-name continuation assembling "get_weatherread_file" is a prefix
    // of the pre-onPayload set but not of the post-onPayload set, so it must be
    // refused rather than forwarded under the dropped name.
    const parsed = [
      [
        parseMistralToolCall({
          id: "call_x",
          index: 0,
          function: { name: "get_weather", arguments: '{"city":"Paris"}' },
        }),
      ],
      [
        parseMistralToolCall({
          id: "call_x",
          index: 0,
          function: { name: "read_file", arguments: "" },
        }),
      ],
    ];
    mistralMockState.streamResult = mistralToolStream("response-onpayload-tools", ...parsed);
    const result = await runMistralFixture(
      {
        ...context,
        tools: [
          { ...makeHealthyTool(), name: "get_weather" },
          { ...makeHealthyTool(), name: "get_weatherread_file" },
        ] as never,
      },
      {
        onPayload: (payload) => {
          const p = payload as {
            tools?: Array<{ function: { name: string } }>;
          };
          if (p.tools) {
            p.tools = p.tools.filter((tool) => tool.function.name === "get_weather");
          }
          return p;
        },
      },
    );

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(
      "Mistral streamed tool-call continuation changed function name; refusing to merge arguments",
    );
  });

  it("does not concatenate when a late id adopts a name-matched block", async () => {
    // openclaw deliberately supports id-less Mistral-compatible endpoints. When
    // an idless opening fragment resolves by name and the explicit id arrives
    // on a later frame, the name-match branch can only be reached when the
    // incoming name already equals the block's recorded name — so appending
    // there could only duplicate it (get_weather + get_weather => get_weatherget_weather).
    // The idempotency guard (block.name !== functionName) must skip the append,
    // settling on the original name rather than synthesizing an unmatched one.
    const { toolCalls } = await runMistralToolFixture("response-late-id-adoption", [
      [
        {
          index: 0,
          function: { name: "get_weather", arguments: '{"city":' },
        },
      ],
      [
        {
          id: "call_late",
          index: 0,
          function: { name: "get_weather", arguments: '"Paris"}' },
        },
      ],
    ]);

    expect(toolCalls).toMatchObject([
      { id: "call_late", name: "get_weather", arguments: { city: "Paris" } },
    ]);
  });
});
