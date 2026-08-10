// Model special token helpers strip model control tokens outside code regions.
import { findCodeRegions, isInsideCode } from "./code-regions.js";

// Match both ASCII pipe <|...|> and full-width pipe <｜...｜> (U+FF5C) variants.
const MODEL_SPECIAL_TOKEN_RE = /<[|｜][^|｜]*[|｜]>/g;

function overlapsCodeRegion(
  start: number,
  end: number,
  codeRegions: { start: number; end: number }[],
): boolean {
  return codeRegions.some((region) => start < region.end && end > region.start);
}

// A word character is a letter, mark (combining marks belong to the preceding
// base letter), digit, or underscore (Unicode-aware). Punctuation and markup
// delimiters (`.`, `(`, `**`, etc.) are NOT word characters, so removing a
// control token next to them does not concatenate two words and needs no separator.
const WORD_CHAR_RE = /^[\p{L}\p{M}\p{N}_]+$/u;
function isWordChar(ch: string | undefined): boolean {
  return Boolean(ch) && WORD_CHAR_RE.test(ch!);
}

// The complete Unicode character at `pos` (surrogate-pair aware), or undefined
// past the end of the string. Indexed `text[pos]` would yield a lone UTF-16
// code unit for non-BMP letters.
function codePointAt(text: string, pos: number): string | undefined {
  if (pos >= text.length) {
    return undefined;
  }
  const cp = text.codePointAt(pos);
  return cp === undefined ? undefined : String.fromCodePoint(cp);
}

// The complete Unicode character immediately before `pos` (surrogate-pair
// aware), or undefined at the start of the string.
function lastCodePointBefore(text: string, pos: number): string | undefined {
  if (pos <= 0) {
    return undefined;
  }
  const prev = text[pos - 1];
  if (prev !== undefined && /[\uDC00-\uDFFF]/.test(prev) && pos >= 2) {
    const pair = text.slice(pos - 2, pos);
    const cp = pair.codePointAt(0);
    if (cp !== undefined && cp > 0xffff) {
      return pair;
    }
  }
  return prev;
}

// Walks backwards from `pos` collecting the preceding code point and any
// combining marks (U+0300-U+036F etc.) that decorate it, so a decomposed
// letter like NFD é (e + U+0301) is treated as one word unit.
function charBefore(text: string, pos: number): string | undefined {
  if (pos <= 0) {
    return undefined;
  }
  let end = pos;
  while (end > 0) {
    const prev = text[end - 1];
    if (prev === undefined || !/\p{M}/u.test(prev)) {
      break;
    }
    end -= 1;
  }
  if (end <= 0) {
    return text.slice(0, pos);
  }
  const base = lastCodePointBefore(text, end);
  return base === undefined ? text.slice(0, pos) : text.slice(end - base.length, pos);
}

// Only insert a separator when removing the token would otherwise join two
// adjacent word characters. Punctuation and markup boundaries already provide
// the required boundary and must be left untouched.
function shouldInsertSeparator(before: string | undefined, after: string | undefined): boolean {
  return isWordChar(before) && isWordChar(after);
}

/**
 * Strips leaked model control tokens like `<|endoftext|>` or full-width pipe variants.
 * Code examples are preserved; remove this when providers stop emitting these tokens.
 *
 * @see https://github.com/openclaw/openclaw/issues/40020
 */
export function stripModelSpecialTokens(text: string): string {
  if (!text) {
    return text;
  }
  MODEL_SPECIAL_TOKEN_RE.lastIndex = 0;
  if (!MODEL_SPECIAL_TOKEN_RE.test(text)) {
    return text;
  }
  MODEL_SPECIAL_TOKEN_RE.lastIndex = 0;

  const codeRegions = findCodeRegions(text);
  // Pre-compute matches with a `removable` flag, plus disjoint sorted arrays of
  // the removable spans for an O(log m) "is this position inside a stripped
  // token?" lookup. Keeps the shared outbound-text path linear on long token runs.
  const matches = [...text.matchAll(MODEL_SPECIAL_TOKEN_RE)].map((m) => {
    const matched = m[0];
    const start = m.index ?? 0;
    const end = start + matched.length;
    const removable =
      !isInsideCode(start, codeRegions) && !overlapsCodeRegion(start, end, codeRegions);
    return { matched, start, end, removable };
  });
  const removableStarts: number[] = [];
  const removableEnds: number[] = [];
  for (const m of matches) {
    if (m.removable) {
      removableStarts.push(m.start);
      removableEnds.push(m.end);
    }
  }
  const inRemovable = (pos: number): boolean => {
    let lo = 0;
    let hi = removableStarts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const start = removableStarts[mid];
      if (start === undefined) {
        break;
      }
      if (start <= pos) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return hi >= 0 && pos < (removableEnds[hi] ?? Infinity);
  };

  // The retained character before `pos`, skipping an immediately preceding
  // removable-token run so the separator is decided from the final retained
  // neighbors and fires only once per run. Returns undefined when `pos` is
  // preceded by another removable token (so only the run's first token inserts).
  const retainedBefore = (pos: number): string | undefined => {
    let p = pos;
    let skipped = false;
    while (p > 0) {
      const ch = charBefore(text, p);
      if (ch === undefined) {
        return undefined;
      }
      const charStart = p - ch.length;
      if (!inRemovable(charStart)) {
        return skipped ? undefined : ch;
      }
      skipped = true;
      p = charStart;
    }
    return undefined;
  };
  // The retained character after `pos`, skipping an immediately following
  // removable-token run. Combining marks trailing the run are emitted by the
  // caller so they stay attached to the preceding base letter.
  const retainedAfter = (pos: number): string | undefined => {
    let p = pos;
    while (p < text.length) {
      const ch = codePointAt(text, p);
      if (ch === undefined || !inRemovable(p)) {
        return ch;
      }
      p += ch.length;
    }
    return undefined;
  };

  let out = "";
  let cursor = 0;
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    if (match === undefined) {
      continue; // consumed by an earlier coalesced run
    }
    const { matched, start, end, removable } = match;
    if (start < cursor) {
      continue; // consumed by an earlier coalesced run
    }
    out += text.slice(cursor, start);
    if (!removable) {
      out += matched;
      cursor = end;
      continue;
    }
    // Coalesce the maximal run of consecutive removable tokens starting here,
    // then any trailing combining marks. A mark decorates the preceding
    // retained base, so it stays attached to whatever precedes the run; deciding
    // the separator once from the two retained neighbors also yields a single
    // space across a consecutive token run.
    let runEnd = end;
    while (i + 1 < matches.length) {
      const next = matches[i + 1];
      if (next === undefined || !next.removable || next.start !== runEnd) {
        break;
      }
      i += 1;
      runEnd = next.end;
    }
    let markEnd = runEnd;
    while (markEnd < text.length && /^\p{M}/u.test(codePointAt(text, markEnd) ?? "")) {
      markEnd += (codePointAt(text, markEnd) ?? "").length;
    }
    out += text.slice(runEnd, markEnd);
    if (shouldInsertSeparator(retainedBefore(start), retainedAfter(markEnd))) {
      out += " ";
    }
    cursor = markEnd;
  }
  out += text.slice(cursor);
  return out;
}
