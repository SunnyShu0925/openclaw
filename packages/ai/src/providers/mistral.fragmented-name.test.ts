import { toolCallFromJSON, type ToolCall } from "@mistralai/mistralai/models/components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { Context, Model } from "../types.js";

const mistralMockState = vi.hoisted(() => {
  const key = "__mistralMockState";
  const g = globalThis as Record<string, unknown>;
  if (!g[key]) {
    g[key] = {
      configs: [] as unknown[],
      payloads: [] as unknown[],
      requestOptions: [] as unknown[],
      randomUUIDs: [] as string[],
      requestThroughHttpClient: false,
      streamError: new Error("stop before network") as unknown,
      streamResult: undefined as unknown,
    };
  }
  return g[key];
});

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

import { streamMistral } from "./mistral.js";

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
