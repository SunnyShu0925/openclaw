// Covers the WebSocket handshake timeout in connectWebSocket.
// Uses vi.useFakeTimers() to fast-forward past the deadline without waiting.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectWebSocketForTest,
  parseWebSocketForTest,
  resetOpenAICodexWebSocketStateForTest,
} from "./openai-chatgpt-responses.js";

function mockNeverOpenWebSocket(): {
  getCloseCode: () => number | undefined;
  getCloseReason: () => string | undefined;
} {
  let closeCode: number | undefined;
  let closeReason: string | undefined;

  class NeverOpenWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = NeverOpenWebSocket.CONNECTING;
    private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

    addEventListener(event: string, listener: (...args: unknown[]) => void): void {
      if (!this.listeners.has(event)) {
        this.listeners.set(event, new Set());
      }
      this.listeners.get(event)?.add(listener);
    }

    removeEventListener(event: string, listener: (...args: unknown[]) => void): void {
      this.listeners.get(event)?.delete(listener);
    }

    close(code: number, reason: string): void {
      closeCode = code;
      closeReason = reason;
      this.readyState = NeverOpenWebSocket.CLOSED;
    }
  }

  vi.stubGlobal("WebSocket", NeverOpenWebSocket as unknown);
  return { getCloseCode: () => closeCode, getCloseReason: () => closeReason };
}

describe("connectWebSocket handshake timeout", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetOpenAICodexWebSocketStateForTest();
  });

  it("applies default 30s timer when no handshakeTimeoutMs is specified", async () => {
    vi.useFakeTimers();
    try {
      const mock = mockNeverOpenWebSocket();

      const wsPromise = connectWebSocketForTest(
        "wss://responses.openai.com/ws",
        new Headers({ Authorization: "Bearer test" }),
      );

      const rejected = expect(wsPromise).rejects.toThrow(
        "WebSocket connection to OpenAI Responses API timed out after 30000ms",
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;

      expect(mock.getCloseCode()).toBe(1000);
      expect(mock.getCloseReason()).toBe("handshake_timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses caller-specified handshakeTimeoutMs when provided", async () => {
    vi.useFakeTimers();
    try {
      const mock = mockNeverOpenWebSocket();

      const wsPromise = connectWebSocketForTest(
        "wss://responses.openai.com/ws",
        new Headers({ Authorization: "Bearer test" }),
        undefined,
        5_000,
      );

      const rejected = expect(wsPromise).rejects.toThrow(
        "WebSocket connection to OpenAI Responses API timed out after 5000ms",
      );
      // Timer fires at 5s instead of 30s.
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;

      expect(mock.getCloseCode()).toBe(1000);
      expect(mock.getCloseReason()).toBe("handshake_timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("timer still fires when a cancellation signal is present", async () => {
    vi.useFakeTimers();
    try {
      const mock = mockNeverOpenWebSocket();
      const controller = new AbortController();

      const wsPromise = connectWebSocketForTest(
        "wss://responses.openai.com/ws",
        new Headers({ Authorization: "Bearer test" }),
        controller.signal,
      );

      // Advance 30s without aborting — timer fires via handshake timeout.
      const rejected = expect(wsPromise).rejects.toThrow(
        "WebSocket connection to OpenAI Responses API timed out after 30000ms",
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;

      expect(mock.getCloseCode()).toBe(1000);
      expect(mock.getCloseReason()).toBe("handshake_timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves normally when WebSocket opens before timeout", async () => {
    vi.useFakeTimers();
    try {
      class InstantOpenWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        readyState = InstantOpenWebSocket.CONNECTING;
        private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

        addEventListener(event: string, listener: (...args: unknown[]) => void): void {
          if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
          }
          this.listeners.get(event)?.add(listener);
          if (event === "open") {
            this.readyState = InstantOpenWebSocket.OPEN;
            listener();
          }
        }

        removeEventListener(): void {}
        close(): void {}
      }

      vi.stubGlobal("WebSocket", InstantOpenWebSocket as unknown);

      const ws = await connectWebSocketForTest(
        "wss://responses.openai.com/ws",
        new Headers({ Authorization: "Bearer test" }),
      );

      expect(ws).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects with error when WebSocket errors before timeout", async () => {
    vi.useFakeTimers();
    try {
      class ErrorWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        readyState = ErrorWebSocket.CONNECTING;
        private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
        private errorEvent = { error: new Error("connection refused") };

        addEventListener(event: string, listener: (...args: unknown[]) => void): void {
          if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
          }
          this.listeners.get(event)?.add(listener);
          if (event === "error") {
            listener(this.errorEvent);
          }
        }

        removeEventListener(): void {}
        close(): void {}
      }

      vi.stubGlobal("WebSocket", ErrorWebSocket as unknown);

      await expect(
        connectWebSocketForTest(
          "wss://responses.openai.com/ws",
          new Headers({ Authorization: "Bearer test" }),
        ),
      ).rejects.toThrow("connection refused");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects with abort error when signal aborts before timeout", async () => {
    vi.useFakeTimers();
    try {
      mockNeverOpenWebSocket();

      const controller = new AbortController();
      controller.abort();

      await expect(
        connectWebSocketForTest(
          "wss://responses.openai.com/ws",
          new Headers({ Authorization: "Bearer test" }),
          controller.signal,
        ),
      ).rejects.toThrow("Request was aborted");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("WebSocket message size bounds", () => {
  function mockMessageSocket(): {
    socket: Parameters<typeof parseWebSocketForTest>[0];
    emitMessage: (data: unknown) => void;
    getCloseCode: () => number | undefined;
  } {
    let closeCode: number | undefined;
    const listeners = new Map<string, Set<(event: unknown) => void>>();
    const socket = {
      close(code?: number): void {
        closeCode = code;
      },
      send(): void {},
      addEventListener(event: string, listener: (event: unknown) => void): void {
        if (!listeners.has(event)) {
          listeners.set(event, new Set());
        }
        listeners.get(event)?.add(listener);
      },
      removeEventListener(): void {},
    };
    return {
      socket,
      emitMessage: (data) => {
        for (const listener of listeners.get("message") ?? []) {
          listener({ data });
        }
      },
      getCloseCode: () => closeCode,
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    resetOpenAICodexWebSocketStateForTest();
  });

  it("rejects an oversized message and closes the socket with 1009", async () => {
    const { socket, emitMessage, getCloseCode } = mockMessageSocket();
    const stream = parseWebSocketForTest(socket, undefined, 8);

    // Start the generator so the message listener is registered, then emit.
    const nextPromise = stream.next();
    emitMessage('{"type":"response.completed"}');

    await expect(nextPromise).rejects.toThrow(
      "WebSocket message exceeds maximum size of 8 bytes (received 29)",
    );
    expect(getCloseCode()).toBe(1009);
  });

  it("counts UTF-8 bytes, not string length, for multibyte payloads", async () => {
    const { socket, emitMessage, getCloseCode } = mockMessageSocket();
    const stream = parseWebSocketForTest(socket, undefined, 12);

    // 6 characters, but 18 UTF-8 bytes — a naive charCode count would pass.
    const nextPromise = stream.next();
    emitMessage("€".repeat(6));

    await expect(nextPromise).rejects.toThrow(
      "WebSocket message exceeds maximum size of 12 bytes (received 18)",
    );
    expect(getCloseCode()).toBe(1009);
  });

  it("passes payloads exactly at the byte limit through the size gate", async () => {
    const { socket, emitMessage, getCloseCode } = mockMessageSocket();
    const stream = parseWebSocketForTest(socket, undefined, 4);

    // 2 bytes ≤ 4-byte limit: size gate passes, JSON parse then fails —
    // proving the boundary is inclusive and the failure is not the size guard.
    const nextPromise = stream.next();
    emitMessage(new Uint8Array([0x7b, 0x61]).buffer);

    await expect(nextPromise).rejects.toThrow("Invalid Codex WebSocket JSON");
    expect(getCloseCode()).toBeUndefined();
  });

  it("parses messages within the limit", async () => {
    const { socket, emitMessage } = mockMessageSocket();
    const stream = parseWebSocketForTest(socket, undefined, 1024);

    const firstPromise = stream.next();
    emitMessage('{"type":"response.completed"}');

    const first = await firstPromise;
    expect(first.done).toBe(false);
    expect(first.value).toEqual({ type: "response.completed" });
    // Stream closes cleanly after the completion event.
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("rejects oversized Blobs from size metadata without reading them", async () => {
    const { socket, emitMessage, getCloseCode } = mockMessageSocket();
    const stream = parseWebSocketForTest(socket, undefined, 8);

    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const nextPromise = stream.next();
    emitMessage({ size: 29, arrayBuffer });

    await expect(nextPromise).rejects.toThrow(
      "WebSocket message exceeds maximum size of 8 bytes (received 29)",
    );
    expect(getCloseCode()).toBe(1009);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("decodes accepted Blobs once using size metadata", async () => {
    const { socket, emitMessage } = mockMessageSocket();
    const stream = parseWebSocketForTest(socket, undefined, 1024);

    const payload = new TextEncoder().encode('{"type":"response.completed"}');
    const arrayBuffer = vi.fn(async () => payload.buffer);
    const nextPromise = stream.next();
    emitMessage({ size: payload.byteLength, arrayBuffer });

    const first = await nextPromise;
    expect(first.done).toBe(false);
    expect(first.value).toEqual({ type: "response.completed" });
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("retains one read for blob-likes without size metadata", async () => {
    const { socket, emitMessage } = mockMessageSocket();
    const stream = parseWebSocketForTest(socket, undefined, 1024);

    const payload = new TextEncoder().encode('{"type":"response.completed"}');
    const arrayBuffer = vi.fn(async () => payload.buffer);
    const nextPromise = stream.next();
    // No `size` property — measurement must read once and reuse the buffer.
    emitMessage({ arrayBuffer });

    const first = await nextPromise;
    expect(first.done).toBe(false);
    expect(first.value).toEqual({ type: "response.completed" });
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
  });
});
