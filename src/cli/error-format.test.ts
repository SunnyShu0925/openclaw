import { describe, expect, it } from "vitest";
import { formatStrictJsonParseFailure } from "./error-format.js";

describe("formatStrictJsonParseFailure", () => {
  it("keeps the bounded JSON preview UTF-16 well-formed", () => {
    const value = `${"x".repeat(44)}🚀tail`;

    const message = formatStrictJsonParseFailure({ value, cause: "invalid token" });

    expect(message).toContain(`${"x".repeat(44)}...`);
    expect(message).not.toContain("\uD83D");
  });

  it.each([
    { raw: "[telegram:123]", label: "stripped array" },
    { raw: "{key:value}", label: "stripped object" },
    { raw: "  [1,2]", label: "leading-whitespace array" },
    { raw: "[[1,2]]", label: "nested stripped" },
    { raw: "{owner:O'Brien}", label: "apostrophe in content" },
    { raw: "['valid']", label: "single-quoted array content" },
  ])(
    "suggests config patch --file when value is a balanced bracket/brace with no double quotes ($label)",
    ({ raw }) => {
      const message = formatStrictJsonParseFailure({ value: raw, cause: "invalid token" });

      expect(message).toContain("config patch --file");
      expect(message).toContain("Windows PowerShell");
      expect(message).toContain("./openclaw.patch.json5");
    },
  );

  it.each([
    { raw: "not-json", label: "plain text" },
    { raw: "42", label: "number" },
    { raw: "true", label: "boolean" },
    { raw: "", label: "empty string" },
    { raw: "   ", label: "whitespace only" },
    { raw: "{bad", label: "incomplete object" },
    { raw: "[telegram:123", label: "unclosed array" },
    { raw: "[", label: "bare open bracket" },
    { raw: '["valid"]', label: "array with double quotes" },
    { raw: '{"key":"val"}', label: "object with double quotes" },
  ])(
    "does not suggest config patch for incomplete, quoted, or non-structured values ($label)",
    ({ raw }) => {
      const message = formatStrictJsonParseFailure({ value: raw, cause: "invalid token" });

      expect(message).not.toContain("config patch --file");
    },
  );
});
