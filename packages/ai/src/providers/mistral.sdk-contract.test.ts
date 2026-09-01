// SDK contract proof: the pinned @mistralai/mistralai@2.5.0 accumulator
// concatenates fragmented function names, not just arguments. This test
// invokes the real SDK accumulator (not a mock) to establish the provider
// contract that this PR's name-assembly mirrors.
import { describe, expect, it } from "vitest";
import {
  accumulateChunksToResponseDict,
  parseSseChunks,
} from "@mistralai/mistralai/extra/observability/streaming.js";

function sseChunks(rawChunks: Array<Record<string, unknown>>): unknown[] {
  const sseText =
    rawChunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n\n") +
    "\n\ndata: [DONE]\n\n";
  return parseSseChunks(sseText);
}

function chunk(opts: {
  toolCalls?: Array<{
    id?: string;
    index?: number;
    function: { name?: string; arguments?: string };
  }>;
  finishReason?: string | null;
}): Record<string, unknown> {
  const delta: Record<string, unknown> = {};
  if (opts.toolCalls) {
    delta.tool_calls = opts.toolCalls.map((tc) => ({
      id: tc.id ?? "null",
      index: tc.index ?? 0,
      function: {
        name: tc.function.name ?? "",
        arguments: tc.function.arguments ?? "",
      },
    }));
  }
  return {
    id: "resp-1",
    model: "mistral-large-latest",
    choices: [
      {
        index: 0,
        delta,
        finish_reason: opts.finishReason ?? null,
      },
    ],
  };
}

function accumulatedToolCalls(chunks: unknown[]): Array<{
  id: string;
  function: { name: string; arguments: string };
}> {
  const result = accumulateChunksToResponseDict(chunks as never) as {
    choices: Array<{
      message: {
        tool_calls?: Array<{
          id: string;
          function: { name: string; arguments: string };
        }>;
      };
    }>;
  };
  return result.choices[0]?.message?.tool_calls ?? [];
}

describe("Mistral SDK accumulator contract — fragmented function names", () => {
  it("concatenates nonempty name fragments on a stable id and index", () => {
    const toolCalls = accumulatedToolCalls(
      sseChunks([
        chunk({
          toolCalls: [
            {
              id: "call_name",
              index: 0,
              function: { name: "get_", arguments: '{"city":' },
            },
          ],
        }),
        chunk({
          toolCalls: [
            {
              id: "call_name",
              index: 0,
              function: { name: "weather", arguments: '"Paris"}' },
            },
          ],
          finishReason: "tool_calls",
        }),
      ]),
    );

    expect(toolCalls).toEqual([
      {
        id: "call_name",
        function: { name: "get_weather", arguments: '{"city":"Paris"}' },
      },
    ]);
  });

  it("concatenates name fragments across more than two chunks", () => {
    const toolCalls = accumulatedToolCalls(
      sseChunks([
        chunk({
          toolCalls: [
            {
              id: "call_a",
              index: 0,
              function: { name: "get_", arguments: "" },
            },
          ],
        }),
        chunk({
          toolCalls: [
            {
              id: "call_a",
              index: 0,
              function: { name: "cur", arguments: "" },
            },
          ],
        }),
        chunk({
          toolCalls: [
            {
              id: "call_a",
              index: 0,
              function: { name: "rent", arguments: '{"q":"x"}' },
            },
          ],
          finishReason: "tool_calls",
        }),
      ]),
    );

    expect(toolCalls).toEqual([
      {
        id: "call_a",
        function: { name: "get_current", arguments: '{"q":"x"}' },
      },
    ]);
  });

  it("preserves a one-shot full name without duplication", () => {
    const toolCalls = accumulatedToolCalls(
      sseChunks([
        chunk({
          toolCalls: [
            {
              id: "call_one",
              index: 0,
              function: { name: "get_weather", arguments: '{"city":"Paris"}' },
            },
          ],
          finishReason: "tool_calls",
        }),
      ]),
    );

    expect(toolCalls).toEqual([
      {
        id: "call_one",
        function: { name: "get_weather", arguments: '{"city":"Paris"}' },
      },
    ]);
  });

  it("does not alter the accumulated name when a continuation fragment is empty", () => {
    const toolCalls = accumulatedToolCalls(
      sseChunks([
        chunk({
          toolCalls: [
            {
              id: "call_name",
              index: 0,
              function: { name: "get_weather", arguments: '{"city":' },
            },
          ],
        }),
        chunk({
          toolCalls: [
            {
              id: "call_name",
              index: 0,
              function: { name: "", arguments: '"Paris"}' },
            },
          ],
          finishReason: "tool_calls",
        }),
      ]),
    );

    expect(toolCalls).toEqual([
      {
        id: "call_name",
        function: { name: "get_weather", arguments: '{"city":"Paris"}' },
      },
    ]);
  });
});
