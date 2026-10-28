import { expect, it } from "vitest";
import { matchesPromotionSelector } from "./cli-index-search.runtime.js";

const NFC_SNIPPET = "Review the München incident report";
const NFD_SNIPPET = "Review the Mu\u0308nchen incident report";

it.each([
  [NFC_SNIPPET, NFD_SNIPPET],
  [NFD_SNIPPET, NFC_SNIPPET],
])(
  "matches a canonically equivalent memory promotion selector without rewriting it (%s selector → %s stored)",
  (selector, storedSnippet) => {
    const candidate = { key: "canonical", path: "/mem/canonical.md", snippet: storedSnippet };
    expect(matchesPromotionSelector(candidate, selector)).toBe(true);
    expect(candidate.snippet).toBe(storedSnippet);
  },
);
