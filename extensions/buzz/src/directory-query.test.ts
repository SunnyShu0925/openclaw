import type { ChannelDirectoryEntry } from "openclaw/plugin-sdk/directory-runtime";
import { describe, expect, it } from "vitest";
import { applyBuzzDirectoryQueryAndLimit } from "./directory-query.js";

const entry = (id: string, name: string): ChannelDirectoryEntry => ({ kind: "group", id, name });

describe("applyBuzzDirectoryQueryAndLimit", () => {
  it.each(["NFC", "NFD"] as const)(
    "matches canonically equivalent room names stored as %s",
    (form) => {
      const cafe = entry("room-1", "Café chatter".normalize(form));
      const other = entry("room-2", "Unrelated");
      // The query arrives in the other canonical form, as decomposed IME input does.
      const query = "CAFÉ".normalize(form === "NFC" ? "NFD" : "NFC");

      expect(applyBuzzDirectoryQueryAndLimit([cafe, other], { query })).toEqual([cafe]);
    },
  );

  it("still applies the limit after canonical matching", () => {
    const entries = [entry("room-1", "Café one"), entry("room-2", "Café two")];

    expect(applyBuzzDirectoryQueryAndLimit(entries, { query: "café", limit: 1 })).toEqual([
      entries[0],
    ]);
  });
});
