/**
 * Regression coverage for model special-token stripping.
 * Ensures provider wrapper tokens do not leak into visible assistant text.
 */
import { describe, expect, it } from "vitest";
import { stripModelSpecialTokens } from "../shared/text/model-special-tokens.js";

/**
 * @see https://github.com/openclaw/openclaw/issues/40020
 */
describe("stripModelSpecialTokens", () => {
  it("strips tokens and inserts space between adjacent words", () => {
    expect(stripModelSpecialTokens("<|user|>Question<|assistant|>Answer")).toBe("Question Answer");
  });

  it("strips full-width pipe variants (DeepSeek U+FF5C)", () => {
    expect(stripModelSpecialTokens("<｜begin▁of▁sentence｜>Hello there")).toBe("Hello there");
  });

  it("does not strip normal angle brackets or HTML", () => {
    expect(stripModelSpecialTokens("a < b && c > d")).toBe("a < b && c > d");
    expect(stripModelSpecialTokens("<div>hello</div>")).toBe("<div>hello</div>");
  });

  it("passes through text without tokens unchanged", () => {
    const text = "Just a normal response.";
    expect(stripModelSpecialTokens(text)).toBe(text);
  });

  it.each([
    {
      name: "before closing punctuation",
      input: "Hello<|assistant|>.",
      expected: "Hello.",
    },
    {
      name: "after opening punctuation",
      input: "(<|assistant|>Hello",
      expected: "(Hello",
    },
    {
      name: "before a Markdown closing delimiter",
      input: "**bold<|assistant|>**",
      expected: "**bold**",
    },
  ])("does not insert a separator $name", ({ input, expected }) => {
    expect(stripModelSpecialTokens(input)).toBe(expected);
  });

  it("does not insert a separator next to non-ASCII punctuation", () => {
    expect(stripModelSpecialTokens("你好<|assistant|>。")).toBe("你好。");
  });

  it("preserves word boundaries for supplementary-plane letters", () => {
    // U+10400 (𐐀) is a non-BMP letter stored as a UTF-16 surrogate pair.
    // Indexed `text[start - 1]` would see only the low surrogate; the boundary
    // lookup must use the complete code point so adjacent letters stay separated.
    expect(stripModelSpecialTokens("𐐀<|assistant|>X")).toBe("𐐀 X");
    expect(stripModelSpecialTokens("X<|assistant|>𐐀")).toBe("X 𐐀");
  });

  it("preserves word boundaries for decomposed combining marks", () => {
    // NFD é (e + U+0301 combining acute) is a letter; the separator must still
    // fire when a token sits between it and another word character.
    const decomposed = "café";
    expect(stripModelSpecialTokens(decomposed + "<|assistant|>X")).toBe(decomposed + " X");
  });

  it("preserves a separator across consecutive removed tokens", () => {
    // Two adjacent control tokens between two word characters must still yield
    // one separator; deciding from the immediate token edge would join the
    // surrounding words. Both pipe widths are exercised.
    expect(stripModelSpecialTokens("Question<|assistant|><|assistant|>Answer")).toBe(
      "Question Answer",
    );
    expect(stripModelSpecialTokens("Question<|a|><|b|>Answer")).toBe("Question Answer");
    expect(stripModelSpecialTokens("a<|assistant|><|assistant|>b")).toBe("a b");
    expect(stripModelSpecialTokens("a<|x|><|y|><|z|>b")).toBe("a b");
  });

  it("keeps a following combining mark attached to its base letter", () => {
    // A combining mark (U+0301) decorates the preceding base letter; removing a
    // token between them must not insert a separator that detaches the mark.
    expect(stripModelSpecialTokens("c<|assistant|>\u0301")).toBe("c\u0301");
    expect(stripModelSpecialTokens("c<|a|>\u0301")).toBe("c\u0301");
    // A combining mark after a token between two letters still attaches to the
    // retained left base, while the right letter stays a separate word.
    expect(stripModelSpecialTokens("ca<|assistant|>\u0301z")).toBe("ca\u0301 z");
  });

  it("keeps a combining mark attached across a consecutive token run", () => {
    // A combining mark after a run of removed tokens still decorates the
    // retained base letter before the run; the mark must stay attached to it
    // (not detach after the separator), and the separator fires once between
    // the marked base and the following word character.
    expect(stripModelSpecialTokens("a<|x|><|y|>\u0301b")).toBe("a\u0301 b");
    expect(stripModelSpecialTokens("ca<|x|><|y|><|z|>\u0301z")).toBe("ca\u0301 z");
  });

  it("keeps a combining mark attached when it sits between two removed tokens", () => {
    // A combining mark between two removed tokens still decorates the retained
    // base letter before the run; both tokens are coalesced into one run and the
    // separator fires once, so the mark does not gain a leading space nor a second
    // separator from the second token.
    expect(stripModelSpecialTokens("a<|x|>\u0301<|y|>b")).toBe("a\u0301 b");
  });

  it("coalesces a long run of consecutive removed tokens into one separator", () => {
    // A long run of leaked tokens must not make the shared sanitizer quadratic:
    // the span-indexed lookup keeps the boundary decision linear in the run length
    // and the whole run still collapses to a single separator between the two word
    // characters.
    const token = "<|t|>";
    const input = "a" + token.repeat(2000) + "b";
    expect(stripModelSpecialTokens(input)).toBe("a b");
  });
});
