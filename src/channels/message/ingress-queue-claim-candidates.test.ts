// Regression coverage for chunked candidate membership in claimNext: large
// candidate id sets are split into bind-variable-safe chunks and merged back in
// the queue's global order, so chunk boundaries never reorder claims.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

async function withTempState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ingress-queue-"));
  try {
    return await fn(stateDir);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function createTestIngressQueue<TPayload>(stateDir: string) {
  return createChannelIngressQueue<TPayload>({
    channelId: "test",
    accountId: "account",
    stateDir,
  });
}

describe("channel ingress queue claim candidate chunks", () => {
  it("bounds candidate membership below SQLite's bind-variable limit", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ text: string }>(stateDir);
      const candidateIds = Array.from({ length: 40_000 }, (_, index) => `candidate-${index}`);
      await expect(queue.claimNext({ ownerId: "worker", candidateIds })).resolves.toBeNull();
    });
  });

  it("claims real rows through chunked candidate membership", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ text: string }>(stateDir);
      const eventIds = Array.from({ length: 1_500 }, (_, index) => `event-${index}`);
      for (const eventId of eventIds) {
        await queue.enqueue(eventId, { text: eventId });
      }
      const first = await queue.claimNext({ ownerId: "worker", candidateIds: eventIds });
      expect(first?.id).toBe("event-0");
      const second = await queue.claimNext({ ownerId: "worker", candidateIds: eventIds });
      expect(second?.id).toBe("event-1");
    });
  });

  it("preserves global claim ordering for unsorted candidate chunks", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ text: string }>(stateDir);
      const eventIds = Array.from({ length: 1_500 }, (_, index) => `event-${index}`);
      for (const eventId of eventIds) {
        await queue.enqueue(eventId, { text: eventId });
      }
      // Reverse the snapshot so the first chunk holds the globally latest rows.
      const candidateIds = eventIds.toReversed();

      const claimed = await queue.claimNext({
        ownerId: "worker",
        candidateIds,
      });

      // The queue's global received order must win over candidate chunk order;
      // a chunk-first scan would have claimed event-1499.
      expect(claimed?.id).toBe("event-0");
    });
  });

  it("deduplicates candidate ids before chunking", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ lane: string }>(stateDir);
      await queue.enqueue("blocked", { lane: "blocked" }, { laneKey: "blocked", receivedAt: 1 });
      await queue.enqueue("free", { lane: "open" }, { laneKey: "open", receivedAt: 2 });

      const claimed = await queue.claimNext({
        ownerId: "worker",
        // 1,001 candidates span two chunks; a duplicated blocked id re-read
        // from both would burn the 2-row scan window before the free row.
        candidateIds: [...Array.from({ length: 1_000 }, () => "blocked"), "free"],
        blockedLaneKeys: ["blocked"],
        deriveLaneKey: (record) => record.payload.lane,
        scanLimit: 2,
      });

      expect(claimed?.id).toBe("free");
    });
  });

  it("preserves SQLite binary event-id ordering across candidate chunks", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ text: string }>(stateDir);
      // Equal received_at rows land in different chunks; SQLite BINARY order
      // claims "B" before "a", while localeCompare would reverse them.
      await queue.enqueue("B", { text: "upper" }, { receivedAt: 50 });
      await queue.enqueue("a", { text: "lower" }, { receivedAt: 50 });
      const candidateIds = [
        ...Array.from({ length: 999 }, (_, index) => `filler-${index}`),
        "B",
        "a",
      ];

      const claimed = await queue.claimNext({ ownerId: "worker", candidateIds });

      expect(claimed?.id).toBe("B");
    });
  });

  it("preserves SQLite binary order for non-BMP event ids across chunks", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ text: string }>(stateDir);
      // U+E000 ("", one BMP code unit) vs U+1F600 ("\u{1F600}", a
      // surrogate pair). SQLite BINARY orders them by UTF-8 bytes:
      // U+E000 = EE 80 80, U+1F600 = F0 9F 98 80, so U+E000 is claimed first.
      // JavaScript's UTF-16 order reverses this: the high surrogate 0xD83D
      // precedes 0xE000, so "" < "\u{1F600}" is false. This regression
      // guards the cross-chunk merge comparator against that divergence.
      const privateUse = "";
      const emoji = "\u{1F600}";
      await queue.enqueue(privateUse, { text: "pu" }, { receivedAt: 50 });
      await queue.enqueue(emoji, { text: "emoji" }, { receivedAt: 50 });
      const candidateIds = [
        ...Array.from({ length: 999 }, (_, index) => `filler-${index}`),
        privateUse,
        emoji,
      ];

      const claimed = await queue.claimNext({ ownerId: "worker", candidateIds });

      expect(claimed?.id).toBe(privateUse);
    });
  });
});
