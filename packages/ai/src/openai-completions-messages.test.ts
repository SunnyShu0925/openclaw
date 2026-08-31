import { describe, expect, it } from "vitest";
import { convertMessages } from "./openai-completions-messages.js";
import type { ProviderContext, ProviderModel } from "./provider-types.js";
import { resolveOpenAICompletionsCompat } from "./transports/openai-completions-compat.js";
import type { AssistantMessage, Context, Model } from "./types.js";

const model: Model<"openai-completions"> = {
  id: "test-model",
  name: "Test model",
  api: "openai-completions",
  provider: "custom-openai-compatible",
  baseUrl: "https://proxy.example/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
};

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("convertMessages assistant text replay", () => {
  it("serializes advertised video in ordered Chat Completions user content", () => {
    const videoModel = {
      ...model,
      input: ["text", "image", "video"],
    } as ProviderModel<"openai-completions">;
    const context: ProviderContext = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "before" },
            { type: "image", mimeType: "image/png", data: "image" },
            { type: "video", mimeType: "video/mp4", data: "video" },
            { type: "text", text: "after" },
          ],
          timestamp: 1,
        },
      ],
    };

    const converted = convertMessages(
      videoModel as Model<"openai-completions">,
      context as Context,
      resolveOpenAICompletionsCompat(videoModel as Model<"openai-completions">),
    );

    expect(converted[0]?.content).toEqual([
      { type: "text", text: "before" },
      { type: "image_url", image_url: { url: "data:image/png;base64,image" } },
      { type: "video_url", video_url: { url: "data:video/mp4;base64,video" } },
      { type: "text", text: "after" },
    ]);
  });

  it("keeps separate assistant text blocks apart", () => {
    const assistant: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [
        { type: "text", text: "Let me check the file." },
        { type: "text", text: "The file contains X." },
      ],
      usage: emptyUsage,
      stopReason: "stop",
      timestamp: 2,
    };
    const context: Context = {
      messages: [{ role: "user", content: "hello", timestamp: 1 }, assistant],
    };

    const converted = convertMessages(model, context, resolveOpenAICompletionsCompat(model));

    const replayed = converted.find((message) => message.role === "assistant");
    expect(replayed?.content).toBe("Let me check the file.\nThe file contains X.");
  });

  it("keeps paired OpenAI tool call ids UTF-16 safe when truncating", () => {
    const prefix = "a".repeat(39);
    const oversizedId = `${prefix}🐱`;
    const targetModel: Model<"openai-completions"> = {
      ...model,
      id: "target-model",
      provider: "openai",
    };
    const assistant: AssistantMessage = {
      role: "assistant",
      api: targetModel.api,
      provider: targetModel.provider,
      model: "source-model",
      content: [{ type: "toolCall", id: oversizedId, name: "lookup", arguments: {} }],
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 1,
    };
    const context: Context = {
      messages: [
        assistant,
        {
          role: "toolResult",
          toolCallId: oversizedId,
          toolName: "lookup",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: 2,
        },
      ],
    };

    const converted = convertMessages(
      targetModel,
      context,
      resolveOpenAICompletionsCompat(targetModel),
    );
    const assistantParam = converted.find((message) => message.role === "assistant");
    const toolParam = converted.find((message) => message.role === "tool");
    const normalizedAssistantId =
      assistantParam?.role === "assistant" ? assistantParam.tool_calls?.[0]?.id : undefined;
    const normalizedToolResultId = toolParam?.role === "tool" ? toolParam.tool_call_id : undefined;

    expect(oversizedId.slice(0, 40).charCodeAt(39)).toBe(0xd83d);
    expect(normalizedAssistantId).toBe(prefix);
    expect(normalizedToolResultId).toBe(prefix);
  });
});

describe("convertMessages parallel tool-result image ownership", () => {
  const imageModel: Model<"openai-completions"> = {
    ...model,
    input: ["text", "image"],
  };

  function makeToolCallAssistant(callIds: string[], toolNames: string[]): AssistantMessage {
    return {
      role: "assistant",
      api: imageModel.api,
      provider: imageModel.provider,
      model: imageModel.id,
      content: callIds.map((id, idx) => ({
        type: "toolCall" as const,
        id,
        name: toolNames[idx] ?? id,
        arguments: {},
      })),
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 1,
    };
  }

  function makeImageToolResult(
    callId: string,
    toolName: string,
    images: Array<{ mimeType: string; data: string }>,
  ) {
    return {
      role: "toolResult" as const,
      toolCallId: callId,
      toolName,
      content: images.map((img) => ({
        type: "image" as const,
        mimeType: img.mimeType,
        data: img.data,
      })),
      isError: false,
      timestamp: 2,
    };
  }

  it("distinguishes image ownership between different parallel result partitions", () => {
    const imgA = { mimeType: "image/png", data: "AAAA" };
    const imgB = { mimeType: "image/png", data: "BBBB" };
    const imgC = { mimeType: "image/png", data: "CCCC" };

    // Partition P: call_a=[A], call_b=[B,C]
    const contextP: Context = {
      messages: [
        makeToolCallAssistant(["call_a", "call_b"], ["screenshot", "camera"]),
        makeImageToolResult("call_a", "screenshot", [imgA]),
        makeImageToolResult("call_b", "camera", [imgB, imgC]),
      ],
    };

    // Partition Q: call_a=[A,B], call_b=[C]
    const contextQ: Context = {
      messages: [
        makeToolCallAssistant(["call_a", "call_b"], ["screenshot", "camera"]),
        makeImageToolResult("call_a", "screenshot", [imgA, imgB]),
        makeImageToolResult("call_b", "camera", [imgC]),
      ],
    };

    const convertedP = convertMessages(
      imageModel,
      contextP,
      resolveOpenAICompletionsCompat(imageModel),
    );
    const convertedQ = convertMessages(
      imageModel,
      contextQ,
      resolveOpenAICompletionsCompat(imageModel),
    );

    const userMsgP = convertedP.find((m) => m.role === "user" && Array.isArray(m.content));
    const userMsgQ = convertedQ.find((m) => m.role === "user" && Array.isArray(m.content));

    // The two partitions must produce different content (ownership is distinguishable)
    expect(JSON.stringify(userMsgP?.content)).not.toBe(JSON.stringify(userMsgQ?.content));

    // Partition P: first group has 1 image from screenshot, second has 2 from camera
    const contentP = userMsgP?.content as Array<{
      type: string;
      text?: string;
      image_url?: { url: string };
    }>;
    expect(contentP).toEqual([
      { type: "text", text: "Image(s) from screenshot (call call_a):" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      { type: "text", text: "Image(s) from camera (call call_b):" },
      { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,CCCC" } },
    ]);

    // Partition Q: first group has 2 images from screenshot, second has 1 from camera
    const contentQ = userMsgQ?.content as Array<{
      type: string;
      text?: string;
      image_url?: { url: string };
    }>;
    expect(contentQ).toEqual([
      { type: "text", text: "Image(s) from screenshot (call call_a):" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
      { type: "text", text: "Image(s) from camera (call call_b):" },
      { type: "image_url", image_url: { url: "data:image/png;base64,CCCC" } },
    ]);
  });

  it("labels single tool-result images with tool name and call id", () => {
    const context: Context = {
      messages: [
        makeToolCallAssistant(["call_x"], ["screenshot"]),
        makeImageToolResult("call_x", "screenshot", [{ mimeType: "image/png", data: "aW1n" }]),
      ],
    };

    const converted = convertMessages(
      imageModel,
      context,
      resolveOpenAICompletionsCompat(imageModel),
    );

    const userMsg = converted.find((m) => m.role === "user" && Array.isArray(m.content));
    expect(userMsg?.content).toEqual([
      { type: "text", text: "Image(s) from screenshot (call call_x):" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aW1n" } },
    ]);
  });

  it("does not emit a user message when tool results have no images", () => {
    const context: Context = {
      messages: [
        makeToolCallAssistant(["call_a", "call_b"], ["lookup", "search"]),
        {
          role: "toolResult",
          toolCallId: "call_a",
          toolName: "lookup",
          content: [{ type: "text", text: "found it" }],
          isError: false,
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_b",
          toolName: "search",
          content: [{ type: "text", text: "no results" }],
          isError: false,
          timestamp: 3,
        },
      ],
    };

    const converted = convertMessages(
      imageModel,
      context,
      resolveOpenAICompletionsCompat(imageModel),
    );

    const userMsgs = converted.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(0);
  });

  it("handles mixed text and image tool results", () => {
    const context: Context = {
      messages: [
        makeToolCallAssistant(["call_a"], ["screenshot"]),
        {
          role: "toolResult",
          toolCallId: "call_a",
          toolName: "screenshot",
          content: [
            { type: "text", text: "Captured screen region" },
            { type: "image", mimeType: "image/png", data: "aW1n" },
          ],
          isError: false,
          timestamp: 2,
        },
      ],
    };

    const converted = convertMessages(
      imageModel,
      context,
      resolveOpenAICompletionsCompat(imageModel),
    );

    // Tool message gets the text content
    const toolMsg = converted.find((m) => m.role === "tool");
    expect(toolMsg).toMatchObject({
      role: "tool",
      content: "Captured screen region",
      tool_call_id: "call_a",
    });

    // User message gets the labeled image
    const userMsg = converted.find((m) => m.role === "user" && Array.isArray(m.content));
    expect(userMsg?.content).toEqual([
      { type: "text", text: "Image(s) from screenshot (call call_a):" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aW1n" } },
    ]);
  });

  it("bounds oversized tool name and call ID in provenance labels", () => {
    const longName = "x".repeat(200);
    const longCallId = "y".repeat(200);
    const context: Context = {
      messages: [
        makeToolCallAssistant([longCallId], [longName]),
        makeImageToolResult(longCallId, longName, [{ mimeType: "image/png", data: "aW1n" }]),
      ],
    };

    const converted = convertMessages(
      imageModel,
      context,
      resolveOpenAICompletionsCompat(imageModel),
    );

    const userMsg = converted.find((m) => m.role === "user" && Array.isArray(m.content));
    const content = userMsg?.content as Array<{ type: string; text?: string }>;
    const labelText = content[0]?.text ?? "";

    // Label must not contain the full 200-char strings
    expect(labelText).not.toContain(longName);
    expect(labelText).not.toContain(longCallId);
    // Label must be bounded
    expect(labelText.length).toBeLessThan(200);
  });
});
