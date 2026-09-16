import type { Context, Model, SimpleStreamOptions } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH } from "../providers/openai-prompt-cache.js";
import {
  buildOpenAIClientHeaders,
  buildOpenAISdkRequestOptions,
} from "./openai-transport-params.js";

const codexModel = {
  id: "gpt-5.6-luna",
  provider: "openai",
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
} as Model;

const context = { messages: [] } satisfies Context;

const proxyResponsesModel = {
  id: "gpt-5.5",
  provider: "openai-proxy",
  api: "openai-responses",
  baseUrl: "https://responses-proxy.example.test/v1",
  compat: { sendSessionIdHeader: true },
} as Model;

describe("buildOpenAIClientHeaders session_id affinity header", () => {
  it("clamps long internal session ids to the backend's 64-char cache key limit", () => {
    const longSessionId = `internal-session-effects-session-companion-${"a".repeat(50)}`;
    const headers = buildOpenAIClientHeaders(
      codexModel,
      context,
      undefined,
      undefined,
      longSessionId,
    );
    const sessionHeader = headers.session_id;
    expect(Array.from(sessionHeader ?? "").length).toBeLessThanOrEqual(
      OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH,
    );
    expect(sessionHeader?.startsWith("internal-session-effects-session-companion-")).toBe(true);
  });

  it("passes short session ids through unchanged", () => {
    const headers = buildOpenAIClientHeaders(codexModel, context, undefined, undefined, "abc-123");
    expect(headers.session_id).toBe("abc-123");
  });

  it.each([
    "openai-responses",
    "openai-chatgpt-responses",
    "azure-openai-responses",
    "openclaw-openai-responses-transport",
    "openclaw-openai-chatgpt-responses-transport",
    "openclaw-azure-openai-responses-transport",
  ] as const)("honors the explicit %s proxy session header opt-in", (api) => {
    const headers = buildOpenAIClientHeaders(
      { ...proxyResponsesModel, api },
      context,
      undefined,
      undefined,
      "proxy-session-123",
    );

    expect(headers.session_id).toBe("proxy-session-123");
  });

  it.each(["short", "none"] as const)(
    "preserves a mixed-case caller header with %s retention",
    (cacheRetention) => {
      const headers = buildOpenAIClientHeaders(
        proxyResponsesModel,
        context,
        { SeSsIoN_Id: "caller-affinity" },
        undefined,
        "generated-affinity",
        cacheRetention,
      );
      expect(new Headers(headers).get("session_id")).toBe("caller-affinity");
      expect(
        Object.keys(headers).filter((name) => name.toLowerCase() === "session_id"),
      ).toHaveLength(1);
    },
  );

  it("honors an explicit native Responses session header opt-out", () => {
    const headers = buildOpenAIClientHeaders(
      { ...codexModel, compat: { sendSessionIdHeader: false } },
      context,
      undefined,
      undefined,
      "native-session-123",
    );

    expect(headers.session_id).toBeUndefined();
  });

  it("omits generated Responses session headers when caching is disabled", () => {
    const headers = buildOpenAIClientHeaders(
      proxyResponsesModel,
      context,
      undefined,
      undefined,
      "proxy-session-123",
      "none",
    );

    expect(headers.session_id).toBeUndefined();
  });
});

describe("buildOpenAIClientHeaders completions session affinity", () => {
  const completionsModel = {
    id: "accounts/fireworks/models/kimi-k2p6",
    provider: "fireworks",
    api: "openai-completions",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    compat: { sendSessionAffinityHeaders: true },
  } as Model;

  const completionsModelNoAffinity = {
    id: "test-model",
    provider: "test",
    api: "openai-completions",
    baseUrl: "https://api.test.com/v1",
  } as Model;

  const completionsModelOpenRouter = {
    id: "model",
    provider: "openrouter",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    compat: { sendSessionAffinityHeaders: true, thinkingFormat: "openrouter" },
  } as Model;

  it("injects three affinity headers when sendSessionAffinityHeaders is enabled", () => {
    const headers = buildOpenAIClientHeaders(
      completionsModel,
      context,
      undefined,
      undefined,
      "session-123",
      "short",
    );
    expect(headers["x-session-affinity"]).toBe("session-123");
    expect(headers["x-client-request-id"]).toBe("session-123");
    expect(headers.session_id).toBe("session-123");
  });

  it("does not inject affinity headers when sendSessionAffinityHeaders is not set", () => {
    const headers = buildOpenAIClientHeaders(
      completionsModelNoAffinity,
      context,
      undefined,
      undefined,
      "session-123",
      "short",
    );
    expect(headers["x-session-affinity"]).toBeUndefined();
    expect(headers["x-client-request-id"]).toBeUndefined();
    expect(headers.session_id).toBeUndefined();
  });

  it("does not inject affinity headers when cacheRetention is none", () => {
    const headers = buildOpenAIClientHeaders(
      completionsModel,
      context,
      undefined,
      undefined,
      "session-123",
      "none",
    );
    expect(headers["x-session-affinity"]).toBeUndefined();
    expect(headers["x-client-request-id"]).toBeUndefined();
    expect(headers.session_id).toBeUndefined();
  });

  it("preserves caller-provided affinity headers over generated ones", () => {
    const headers = buildOpenAIClientHeaders(
      completionsModel,
      context,
      {
        "x-session-affinity": "caller-affinity",
        "x-client-request-id": "caller-request",
        session_id: "caller-session",
      },
      undefined,
      "session-123",
      "short",
    );
    expect(headers["x-session-affinity"]).toBe("caller-affinity");
    expect(headers["x-client-request-id"]).toBe("caller-request");
    expect(new Headers(headers).get("session_id")).toBe("caller-session");
  });

  it("injects x-session-id for OpenRouter affinity format", () => {
    const headers = buildOpenAIClientHeaders(
      completionsModelOpenRouter,
      context,
      undefined,
      undefined,
      "session-123",
      "short",
    );
    expect(headers["x-session-id"]).toBe("session-123");
    expect(headers["x-session-affinity"]).toBeUndefined();
    expect(headers["x-client-request-id"]).toBeUndefined();
  });

  it("does not inject affinity headers when sessionId is absent", () => {
    const headers = buildOpenAIClientHeaders(
      completionsModel,
      context,
      undefined,
      undefined,
      undefined,
      "short",
    );
    expect(headers["x-session-affinity"]).toBeUndefined();
    expect(headers["x-client-request-id"]).toBeUndefined();
    expect(headers.session_id).toBeUndefined();
  });

  it("preserves model-level configured affinity headers over generated ones", () => {
    const modelWithHeaders = {
      ...completionsModel,
      headers: {
        "x-session-affinity": "configured-affinity",
        "x-client-request-id": "configured-request",
        session_id: "configured-session",
      },
    } as Model;
    const headers = buildOpenAIClientHeaders(
      modelWithHeaders,
      context,
      undefined,
      undefined,
      "generated-session",
      "short",
    );
    expect(headers["x-session-affinity"]).toBe("configured-affinity");
    expect(headers["x-client-request-id"]).toBe("configured-request");
    expect(new Headers(headers).get("session_id")).toBe("configured-session");
  });

  it("preserves model-level configured OpenRouter session header over generated one", () => {
    const modelWithHeaders = {
      ...completionsModelOpenRouter,
      headers: { "x-session-id": "configured-or-session" },
    } as Model;
    const headers = buildOpenAIClientHeaders(
      modelWithHeaders,
      context,
      undefined,
      undefined,
      "generated-session",
      "short",
    );
    expect(headers["x-session-id"]).toBe("configured-or-session");
  });

  it("injects affinity headers for the managed completions transport alias", () => {
    const managedAliasModel = {
      ...completionsModel,
      api: "openclaw-openai-completions-transport",
    } as Model;
    const headers = buildOpenAIClientHeaders(
      managedAliasModel,
      context,
      undefined,
      undefined,
      "session-123",
      "short",
    );
    expect(headers["x-session-affinity"]).toBe("session-123");
    expect(headers["x-client-request-id"]).toBe("session-123");
    expect(headers.session_id).toBe("session-123");
  });
});

describe("buildOpenAISdkRequestOptions turn controls", () => {
  const model = {
    id: "gpt-5.6-luna",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  } as Model;

  it.each([undefined, 0, 7])("keeps SDK retries at zero for legacy maxRetries=%s", (maxRetries) => {
    const signal = new AbortController().signal;
    const options: SimpleStreamOptions = { timeoutMs: 1_234, maxRetries };

    expect(buildOpenAISdkRequestOptions(model, signal, options)).toEqual({
      signal,
      timeout: 1_234,
      maxRetries: 0,
    });
  });

  it("does not add a retry policy when the turn does not specify one", () => {
    expect(buildOpenAISdkRequestOptions(model)).toBeUndefined();
  });
});
