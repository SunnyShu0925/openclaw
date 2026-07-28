// Tool-call argument decoding tests cover HTML entity repair for model-emitted
// tool arguments without corrupting invalid numeric entities.
import { describe, expect, it } from "vitest";
import {
  createEscapeSequenceStreamWrapper,
  createHtmlEntityToolCallArgumentDecodingWrapper,
} from "./tool-call-argument-decoding.js";

describe("createHtmlEntityToolCallArgumentDecodingWrapper", () => {
  type DecodedMessage = { content: Array<{ arguments: Record<string, unknown> }> };

  const buildSharedArgumentsAssistant = (
    args: Record<string, unknown> = { content: "&amp;amp;" },
  ) => {
    const toolCall = {
      type: "toolCall" as const,
      id: "call_1",
      name: "write",
      arguments: args,
    };
    const assistant = { role: "assistant" as const, content: [toolCall] };
    const events = [
      { type: "toolcall_end", contentIndex: 0, toolCall, partial: assistant },
      { type: "done", reason: "toolUse", message: assistant },
    ];
    const baseStreamFn = (() => ({
      async *[Symbol.asyncIterator]() {
        for (const event of events) {
          yield event;
        }
      },
      async result() {
        return assistant;
      },
    })) as never;
    return { assistant, baseStreamFn };
  };

  const drive = async (baseStreamFn: never): Promise<DecodedMessage> => {
    const wrapped = createHtmlEntityToolCallArgumentDecodingWrapper(baseStreamFn);
    const stream = wrapped({} as never, {} as never, {} as never) as unknown as {
      [Symbol.asyncIterator](): AsyncIterator<unknown>;
      result(): Promise<DecodedMessage>;
    };
    for await (const event of stream as AsyncIterable<unknown>) {
      void event;
    }
    return stream.result();
  };

  it("decodes nested valid entities while preserving primitive and invalid numeric arguments", async () => {
    const { baseStreamFn } = buildSharedArgumentsAssistant({
      query: "Rock &amp; Roll &#65; &#39;ok&#39; &#x27;hex&#x27;",
      emoji: "ok &#x1F600;",
      args: ["--flag=&quot;value&quot;", "&lt;input&gt;", 42, true, null],
      nested: { deep: "a &amp; b &mdash; &copy;" },
      invalid: "bad &#x110000; and &#9999999999; and &#xD800; and &#55296;",
    });

    const finalMessage = await drive(baseStreamFn);

    expect(finalMessage.content[0]?.arguments).toEqual({
      query: "Rock & Roll A 'ok' 'hex'",
      emoji: "ok 😀",
      args: ['--flag="value"', "<input>", 42, true, null],
      nested: { deep: "a & b — ©" },
      invalid: "bad &#x110000; and &#9999999999; and &#xD800; and &#55296;",
    });
  });

  it("decodes a shared tool-call arguments object exactly once, keyed by object identity, across its partial, message, and result()", async () => {
    const { baseStreamFn } = buildSharedArgumentsAssistant();

    const finalMessage = await drive(baseStreamFn);

    expect(finalMessage.content[0]?.arguments.content).toBe("&amp;");
  });

  it("decodes the same arguments object once even when it flows through two independent wrapper invocations (the guard spans wrapper instances, not a single stream)", async () => {
    const { assistant, baseStreamFn } = buildSharedArgumentsAssistant();
    const secondStreamFn = (() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "done", reason: "toolUse", message: assistant };
      },
      async result() {
        return assistant;
      },
    })) as never;

    const first = await drive(baseStreamFn);
    const second = await drive(secondStreamFn);

    expect(first.content[0]?.arguments.content).toBe("&amp;");
    expect(second.content[0]?.arguments.content).toBe("&amp;");
  });
});

describe("createEscapeSequenceStreamWrapper", () => {
  type DecodedMessage = { content: Array<{ arguments: Record<string, unknown> }> };

  const buildToolCallAssistant = (toolName: string, args: Record<string, unknown>) => {
    const toolCall = {
      type: "toolCall" as const,
      id: "call_1",
      name: toolName,
      arguments: args,
    };
    const assistant = { role: "assistant" as const, content: [toolCall] };
    const events = [
      { type: "toolcall_end", contentIndex: 0, toolCall, partial: assistant },
      { type: "done", reason: "toolUse", message: assistant },
    ];
    const baseStreamFn = (() => ({
      async *[Symbol.asyncIterator]() {
        for (const event of events) {
          yield event;
        }
      },
      async result() {
        return assistant;
      },
    })) as never;
    return { assistant, baseStreamFn };
  };

  const drive = async (baseStreamFn: never): Promise<DecodedMessage> => {
    const wrapped = createEscapeSequenceStreamWrapper(baseStreamFn);
    const stream = wrapped({} as never, {} as never, {} as never) as unknown as {
      [Symbol.asyncIterator](): AsyncIterator<unknown>;
      result(): Promise<DecodedMessage>;
    };
    for await (const event of stream as AsyncIterable<unknown>) {
      void event;
    }
    return stream.result();
  };

  // --- Write tool content (the reported bug scenario) ---

  it("converts multi-line \\n in write tool content to newlines (3+ lines)", async () => {
    const { baseStreamFn } = buildToolCallAssistant("write", {
      content: "import sys\\nsys.path.insert(0, '...')\\nprint('hello')",
    });

    const finalMessage = await drive(baseStreamFn);

    expect(finalMessage.content[0]?.arguments.content).toBe(
      "import sys\nsys.path.insert(0, '...')\nprint('hello')",
    );
  });

  it("preserves single \\n in write tool content (likely Windows path like C:\\Work\\nssm)", async () => {
    const { baseStreamFn } = buildToolCallAssistant("write", {
      content: "C:\\Work\\nssm\\config.txt",
    });

    const finalMessage = await drive(baseStreamFn);

    expect(finalMessage.content[0]?.arguments.content).toBe("C:\\Work\\nssm\\config.txt");
  });

  it("preserves write tool content with only real newlines (no \\n sequences)", async () => {
    const { baseStreamFn } = buildToolCallAssistant("write", {
      content: "line1\nline2\nline3",
    });

    const finalMessage = await drive(baseStreamFn);

    expect(finalMessage.content[0]?.arguments.content).toBe("line1\nline2\nline3");
  });

  it("converts \\t alongside \\n in write tool content to actual tabs", async () => {
    const { baseStreamFn } = buildToolCallAssistant("write", {
      content: "def foo():\\n\\treturn 42\\n\\tprint('done')",
    });

    const finalMessage = await drive(baseStreamFn);

    expect(finalMessage.content[0]?.arguments.content).toBe(
      "def foo():\n\treturn 42\n\tprint('done')",
    );
  });

  it("preserves write tool content unchanged when there are no \\n sequences", async () => {
    const { baseStreamFn } = buildToolCallAssistant("write", {
      content: "plain text without escapes",
    });

    const finalMessage = await drive(baseStreamFn);

    expect(finalMessage.content[0]?.arguments.content).toBe("plain text without escapes");
  });

  it("does not unescape in write tool content when content already has real newlines", async () => {
    const { baseStreamFn } = buildToolCallAssistant("write", {
      content: "ok\nhas literal \\n here\nok",
    });

    const finalMessage = await drive(baseStreamFn);

    expect(finalMessage.content[0]?.arguments.content).toBe("ok\nhas literal \\n here\nok");
  });

  it("decodes \\r\\n Windows line endings in write tool content", async () => {
    const { baseStreamFn } = buildToolCallAssistant("write", {
      content: "line1\\r\\nline2\\r\\nline3",
    });

    const finalMessage = await drive(baseStreamFn);

    expect(finalMessage.content[0]?.arguments.content).toBe("line1\r\nline2\r\nline3");
  });

  // --- P1 coverage: cross-tool preservation ---

  it("preserves shell command arguments unchanged (\\n in commands should stay verbatim)", async () => {
    const { baseStreamFn } = buildToolCallAssistant("shell", {
      command: "grep 'pattern\\nname' file.txt",
    });

    const finalMessage = await drive(baseStreamFn);

    expect(finalMessage.content[0]?.arguments.command).toBe("grep 'pattern\\nname' file.txt");
  });

  it("preserves edit tool arguments unchanged", async () => {
    const { baseStreamFn } = buildToolCallAssistant("edit", {
      content: "replacement\\nwith multiple\\nescaped lines",
    });

    const finalMessage = await drive(baseStreamFn);

    expect(finalMessage.content[0]?.arguments.content).toBe(
      "replacement\\nwith multiple\\nescaped lines",
    );
  });

  it("preserves write tool path field unchanged when it contains \\n", async () => {
    const { baseStreamFn } = buildToolCallAssistant("write", {
      path: "/path/to/file\\nname.txt",
      content: "line1\\nline2\\nline3",
    });

    const finalMessage = await drive(baseStreamFn);

    // content should be decoded (write tool content field)
    expect(finalMessage.content[0]?.arguments.content).toBe("line1\nline2\nline3");
    // path should be preserved (not write tool content field)
    expect(finalMessage.content[0]?.arguments.path).toBe("/path/to/file\\nname.txt");
  });

  it("preserves search query arguments unchanged", async () => {
    const { baseStreamFn } = buildToolCallAssistant("search", {
      query: "find line1\\nline2 pattern",
    });

    const finalMessage = await drive(baseStreamFn);

    expect(finalMessage.content[0]?.arguments.query).toBe("find line1\\nline2 pattern");
  });

  it("preserves bash script arguments unchanged (non-write tool)", async () => {
    const { baseStreamFn } = buildToolCallAssistant("bash", {
      script: "echo 'line1\\nline2'",
    });

    const finalMessage = await drive(baseStreamFn);

    expect(finalMessage.content[0]?.arguments.script).toBe("echo 'line1\\nline2'");
  });

  it("preserves all fields of non-write tools unchanged", async () => {
    const { baseStreamFn } = buildToolCallAssistant("read", {
      path: "dir/file\\nname.txt",
    });

    const finalMessage = await drive(baseStreamFn);

    expect(finalMessage.content[0]?.arguments.path).toBe("dir/file\\nname.txt");
  });

  // --- Dedup and edge cases ---

  it("decodes the same arguments object exactly once (WeakSet dedup)", async () => {
    const { baseStreamFn } = buildToolCallAssistant("write", {
      content: "a\\nb\\nc",
    });

    const finalMessage = await drive(baseStreamFn);

    expect(finalMessage.content[0]?.arguments.content).toBe("a\nb\nc");
  });

  it("handles empty string and whitespace-only content", async () => {
    const { baseStreamFn } = buildToolCallAssistant("write", {
      empty: "",
      spaces: "   ",
    });

    const finalMessage = await drive(baseStreamFn);

    expect(finalMessage.content[0]?.arguments).toEqual({
      empty: "",
      spaces: "   ",
    });
  });
});
