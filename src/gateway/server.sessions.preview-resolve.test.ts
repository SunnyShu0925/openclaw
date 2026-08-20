/**
 * Gateway session preview resolve tests.
 */
import { expect, test, vi } from "vitest";
import * as resetWindow from "../config/sessions/session-accessor.sqlite-reset-window.js";
import type { GatewayClient } from "./server-methods/types.js";
import * as sessionDisplayProjection from "./session-display-projection.js";
import { createToolSummaryPreviewTranscriptLines } from "./session-preview.test-helpers.js";
import { rpcReq, writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionStoreEntry,
  directSessionReq,
  seedSessionTranscript,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

function identifiedClient(profileId: string, scopes: string[] = ["operator.read"]): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
      },
      role: "operator",
      scopes,
    },
    authenticatedUserId: `${profileId}@example.com`,
    authenticatedUserProfile: {
      profileId,
      displayName: profileId,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

test("sessions.preview returns transcript previews", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionId = "sess-preview";
  const lines = createToolSummaryPreviewTranscriptLines(sessionId);

  await writeSessionStore({
    entries: {
      "agent:main:main": sessionStoreEntry(sessionId),
    },
  });
  await seedSessionTranscript({
    sessionId,
    sessionKey: "agent:main:main",
    storePath,
    messages: lines
      .map((line) => JSON.parse(line) as { message?: Record<string, unknown> })
      .map((record) => record.message)
      .filter((message): message is Record<string, unknown> => Boolean(message))
      .map((message) => Object.assign({ role: String(message.role) }, message)),
  });

  const preview = await directSessionReq<{
    previews: Array<{
      key: string;
      status: string;
      items: Array<{ role: string; text: string }>;
    }>;
  }>("sessions.preview", { keys: ["main"], limit: 3, maxChars: 120 });
  expect(preview.ok).toBe(true);
  const entry = preview.payload?.previews[0];
  expect(entry?.key).toBe("main");
  expect(entry?.status).toBe("ok");
  expect(entry?.items).toEqual([
    { role: "user", text: "Hello" },
    { role: "assistant", text: "Hi" },
    { role: "assistant", text: "Forecast ready" },
  ]);
});

test("sessions.preview grows the read window past a toolcall-heavy tail to fill the limit", async () => {
  // The preview reader reads only the visible-message tail and grows it backwards
  // when projection filters out toolcall/control messages, so a toolcall-heavy tail
  // still yields `limit` displayable items rather than stopping short.
  const { storePath } = await createSessionStoreDir();
  const sessionId = "sess-preview-tail";

  await writeSessionStore({
    entries: {
      "agent:main:main": sessionStoreEntry(sessionId),
    },
  });
  await seedSessionTranscript({
    sessionId,
    sessionKey: "agent:main:main",
    storePath,
    messages: [
      { role: "user", content: "msg-1" },
      { role: "assistant", content: "msg-2" },
      { role: "user", content: "msg-3" },
      { role: "assistant", content: "msg-4" },
      { role: "user", content: "msg-5" },
      // Trailing toolcalls that projection filters out; the window must cross
      // these to reach the earlier displayable messages.
      { role: "assistant", content: [{ type: "toolcall", name: "t-1" }] },
      { role: "assistant", content: [{ type: "toolcall", name: "t-2" }] },
      { role: "assistant", content: [{ type: "toolcall", name: "t-3" }] },
    ],
  });

  const preview = await directSessionReq<{
    previews: Array<{
      key: string;
      status: string;
      items: Array<{ role: string; text: string }>;
    }>;
  }>("sessions.preview", { keys: ["main"], limit: 3, maxChars: 120 });
  expect(preview.ok).toBe(true);
  const entry = preview.payload?.previews[0];
  expect(entry?.status).toBe("ok");
  expect(entry?.items).toEqual([
    { role: "user", text: "msg-3" },
    { role: "assistant", text: "msg-4" },
    { role: "user", text: "msg-5" },
  ]);
});

test("sessions.preview reads a bounded visible-message tail instead of the full transcript", async () => {
  // Regression guard: the bounded-tail reader's first read must be a tail window (range <= limit),
  // not a full scan (range == total). Also verifies preview content is correct.
  const { storePath } = await createSessionStoreDir();
  const sessionId = "sess-preview-bounded-read";
  const transcriptSize = 2000;
  const previewLimit = 5;

  await writeSessionStore({
    entries: {
      "agent:main:main": sessionStoreEntry(sessionId),
    },
  });
  await seedSessionTranscript({
    sessionId,
    sessionKey: "agent:main:main",
    storePath,
    messages: Array.from({ length: transcriptSize }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `msg-${index}`,
    })),
  });

  const readRanges: Array<{ start: number; endExclusive: number }> = [];
  const originalRead = resetWindow.readVisibleMessageRange;
  const spy = vi
    .spyOn(resetWindow, "readVisibleMessageRange")
    .mockImplementation((projection, start, endExclusive) => {
      readRanges.push({ start, endExclusive });
      return originalRead(projection, start, endExclusive);
    });

  const preview = await directSessionReq<{
    previews: Array<{ status: string; items: Array<{ role: string; text: string }> }>;
  }>("sessions.preview", { keys: ["main"], limit: previewLimit, maxChars: 120 });
  spy.mockRestore();

  expect(preview.ok).toBe(true);
  // Verify preview content correctness, not just read-range shape.
  const items = preview.payload?.previews[0]?.items ?? [];
  expect(items.length).toBeLessThanOrEqual(previewLimit);
  expect(items[items.length - 1]?.text).toContain(`msg-${transcriptSize - 1}`);
  // The bounded reader's first read must be the tail window, never the whole transcript.
  expect(readRanges.length).toBeGreaterThan(0);
  const firstRead = readRanges[0];
  const firstRange = firstRead ? firstRead.endExclusive - firstRead.start : 0;
  expect(firstRange).toBeLessThanOrEqual(previewLimit);
  expect(readRanges.length).toBeLessThan(30);
});

test("sessions.preview never rereads overlapping tail ranges on an all-filtered tail", async () => {
  // Regression guard: non-overlapping expansion reads each position at most once (total <= transcriptSize).
  // Also verifies all-filtered tail yields zero preview items.
  const { storePath } = await createSessionStoreDir();
  const sessionId = "sess-preview-non-overlapping";
  const transcriptSize = 2000;
  const previewLimit = 5;

  await writeSessionStore({
    entries: {
      "agent:main:main": sessionStoreEntry(sessionId),
    },
  });
  await seedSessionTranscript({
    sessionId,
    sessionKey: "agent:main:main",
    storePath,
    messages: Array.from({ length: transcriptSize }, () => ({
      role: "assistant",
      content: [{ type: "toolcall", name: "tc" }],
    })),
  });

  const readRanges: Array<{ start: number; endExclusive: number }> = [];
  const originalRead = resetWindow.readVisibleMessageRange;
  const spy = vi
    .spyOn(resetWindow, "readVisibleMessageRange")
    .mockImplementation((projection, start, endExclusive) => {
      readRanges.push({ start, endExclusive });
      return originalRead(projection, start, endExclusive);
    });

  const preview = await directSessionReq<{
    previews: Array<{ status: string; items: unknown[] }>;
  }>("sessions.preview", { keys: ["main"], limit: previewLimit, maxChars: 120 });
  spy.mockRestore();

  expect(preview.ok).toBe(true);
  // All-filtered tail yields zero preview items (toolcalls are not displayable).
  expect(preview.payload?.previews[0]?.items ?? []).toHaveLength(0);
  expect(readRanges.length).toBeGreaterThan(0);
  const totalReadPositions = readRanges.reduce(
    (sum, range) => sum + (range.endExclusive - range.start),
    0,
  );
  // The non-overlapping reader reads each position at most once.
  expect(totalReadPositions).toBeLessThanOrEqual(transcriptSize);
});

test("sessions.preview never reprojects messages on an all-filtered tail", async () => {
  // Regression guard for the non-repeating projection. When the tail is made
  // entirely of non-displayable messages (toolcalls), projection yields zero
  // items and the window must grow all the way to the start. The prior
  // implementation re-ran projection over the entire accumulated suffix on
  // every expansion, so total projection work peaked at ~2x the transcript.
  // The fix projects only each newly uncovered prefix interval, so every
  // message is projected at most once.
  //
  // This assertion fails on the reprojecting implementation (projection count
  // > transcript size) and passes once each expansion projects only the new
  // prefix.
  const { storePath } = await createSessionStoreDir();
  const sessionId = "sess-preview-no-reproject";
  const transcriptSize = 2000;
  const previewLimit = 5;

  await writeSessionStore({
    entries: {
      "agent:main:main": sessionStoreEntry(sessionId),
    },
  });
  await seedSessionTranscript({
    sessionId,
    sessionKey: "agent:main:main",
    storePath,
    messages: Array.from({ length: transcriptSize }, () => ({
      role: "assistant",
      content: [{ type: "toolcall", name: "tc" }],
    })),
  });

  const spy = vi
    .spyOn(sessionDisplayProjection, "projectSessionDisplayMessage")
    .mockImplementation(() => null);

  const preview = await directSessionReq<{
    previews: Array<{ status: string; items: unknown[] }>;
  }>("sessions.preview", { keys: ["main"], limit: previewLimit, maxChars: 120 });
  const projectionCalls = spy.mock.calls.length;
  spy.mockRestore();

  expect(preview.ok).toBe(true);
  // Each message is projected at most once, so total projection calls are
  // bounded by one full scan. The prior reprojecting loop called
  // ~2.28x transcriptSize here.
  expect(projectionCalls).toBeLessThanOrEqual(transcriptSize);
});

test("sessions.resolve by sessionId ignores fuzzy-search list limits and returns the exact match", async () => {
  await createSessionStoreDir();
  const now = Date.now();
  const entries: Record<string, { sessionId: string; updatedAt: number; label?: string }> = {
    "agent:main:subagent:target": {
      sessionId: "sess-target-exact",
      updatedAt: now - 20_000,
    },
  };
  for (let i = 0; i < 9; i += 1) {
    entries[`agent:main:subagent:noisy-${i}`] = {
      sessionId: `sess-noisy-${i}`,
      updatedAt: now - i * 1_000,
      label: `sess-target-exact noisy ${i}`,
    };
  }
  await writeSessionStore({ entries });

  const { ws } = await openClient();
  const resolved = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
    sessionId: "sess-target-exact",
  });

  expect(resolved.ok).toBe(true);
  expect(resolved.payload?.key).toBe("agent:main:subagent:target");
});

test("sessions.resolve can probe a missing selector without returning an RPC error", async () => {
  await createSessionStoreDir();
  const { ws } = await openClient();

  const resolved = await rpcReq<{ ok: false }>(ws, "sessions.resolve", {
    key: "agent:main:missing",
    allowMissing: true,
  });

  expect(resolved.ok).toBe(true);
  expect(resolved.payload).toEqual({ ok: false });
});

test("sessions.resolve rejects a missing key by default", async () => {
  await createSessionStoreDir();
  const { ws } = await openClient();

  const resolved = await rpcReq(ws, "sessions.resolve", {
    key: "agent:main:missing",
  });

  expect(resolved.ok).toBe(false);
  expect(resolved.error?.message).toBe("No session found: agent:main:missing");
});

test("sessions.resolve returns short-id ambiguity as a protocol-success result", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      "agent:main:thread:12345678-0aaa-4000-8000-000000000001": {
        sessionId: "sess-short-newer",
        displayName: "Newer",
        updatedAt: 20,
      },
      "agent:main:thread:12345678-0bbb-4000-8000-000000000002": {
        sessionId: "sess-short-older",
        displayName: "Older",
        updatedAt: 10,
      },
    },
  });

  const resolved = await directSessionReq<{
    ok: false;
    candidates: Array<{ key: string; displayName?: string }>;
  }>("sessions.resolve", { shortId: "12345678" });

  expect(resolved.ok).toBe(true);
  expect(resolved.payload).toEqual({
    ok: false,
    candidates: [
      {
        agentId: "main",
        key: "agent:main:thread:12345678-0aaa-4000-8000-000000000001",
        displayName: "Newer",
      },
      {
        agentId: "main",
        key: "agent:main:thread:12345678-0bbb-4000-8000-000000000002",
        displayName: "Older",
      },
    ],
  });
});

test("sessions.resolve filters discovery selectors with sessions.list visibility", async () => {
  await createSessionStoreDir();
  const visibleKey = "agent:main:thread:12345678-0aaa-4000-8000-000000000001";
  const secondVisibleKey = "agent:main:thread:12345678-0ccc-4000-8000-000000000005";
  const hiddenCollisionKey = "agent:main:thread:12345678-0bbb-4000-8000-000000000002";
  const hiddenOnlyKey = "agent:main:thread:deadbeef-0aaa-4000-8000-000000000003";
  const incognitoKey = "agent:main:thread:cafebabe-0aaa-4000-8000-000000000004";
  await writeSessionStore({
    entries: {
      [visibleKey]: {
        sessionId: "sess-collision",
        label: "collision-label",
        displayName: "Visible session",
        updatedAt: 40,
        visibility: "shared",
        createdActor: { type: "human", id: "owner" },
      },
      [hiddenCollisionKey]: {
        sessionId: "sess-collision",
        label: "collision-label",
        displayName: "Hidden collision",
        updatedAt: 30,
        visibility: "draft",
        createdActor: { type: "human", id: "owner" },
      },
      [secondVisibleKey]: {
        sessionId: "sess-second-visible",
        label: "second-visible",
        displayName: "Second visible session",
        updatedAt: 35,
        visibility: "shared",
        createdActor: { type: "human", id: "owner" },
      },
      [hiddenOnlyKey]: {
        sessionId: "sess-hidden-only",
        label: "hidden-only",
        displayName: "Hidden only",
        updatedAt: 20,
        visibility: "draft",
        createdActor: { type: "human", id: "owner" },
      },
      [incognitoKey]: {
        sessionId: "sess-incognito",
        label: "incognito-only",
        displayName: "Incognito only",
        updatedAt: 10,
        visibility: "shared",
        incognito: true,
        createdActor: { type: "human", id: "viewer" },
      },
    },
  });
  const client = identifiedClient("viewer");

  for (const params of [
    { shortId: "deadbeef" },
    { shortId: "cafebabe" },
    { sessionId: "sess-hidden-only" },
    { label: "hidden-only" },
  ]) {
    const hidden = await directSessionReq("sessions.resolve", params, { client });
    expect(hidden.ok).toBe(false);
    expect(hidden.error?.message).toContain("No session found");
  }

  const ambiguous = await directSessionReq<{
    ok: false;
    candidates: Array<{ key: string; displayName?: string }>;
  }>("sessions.resolve", { shortId: "12345678" }, { client });
  expect(ambiguous).toMatchObject({
    ok: true,
    payload: {
      ok: false,
      candidates: [{ key: visibleKey }, { key: secondVisibleKey }],
    },
  });

  for (const params of [{ sessionId: "sess-collision" }, { label: "collision-label" }]) {
    const resolved = await directSessionReq<{ ok: true; key: string }>("sessions.resolve", params, {
      client,
    });
    expect(resolved).toMatchObject({ ok: true, payload: { ok: true, key: visibleKey } });
  }

  const exactKey = await directSessionReq<{ ok: true; key: string }>(
    "sessions.resolve",
    { key: hiddenOnlyKey },
    { client },
  );
  expect(exactKey).toMatchObject({ ok: true, payload: { ok: true, key: hiddenOnlyKey } });

  const ownerDraft = await directSessionReq<{ ok: true; key: string }>(
    "sessions.resolve",
    { shortId: "deadbeef" },
    { client: identifiedClient("owner") },
  );
  expect(ownerDraft).toMatchObject({ ok: true, payload: { ok: true, key: hiddenOnlyKey } });

  const adminIncognito = await directSessionReq<{ ok: true; key: string }>(
    "sessions.resolve",
    { shortId: "cafebabe" },
    { client: identifiedClient("admin", ["operator.admin"]) },
  );
  expect(adminIncognito).toMatchObject({ ok: true, payload: { ok: true, key: incognitoKey } });
});

test.each([
  { params: { shortId: "xyz" }, message: "shortId must be 8-32 hexadecimal characters" },
  { params: { label: "release", slugHint: "release" }, message: "slugHint requires shortId" },
])("sessions.resolve rejects invalid short-ref params: $message", async ({ params, message }) => {
  await createSessionStoreDir();

  const resolved = await directSessionReq("sessions.resolve", params);

  expect(resolved.ok).toBe(false);
  expect(resolved.error?.code).toBe("INVALID_REQUEST");
  expect(resolved.error?.message).toBe(message);
});

test("sessions.resolve by key respects spawnedBy visibility filters", async () => {
  await createSessionStoreDir();
  const now = Date.now();
  await writeSessionStore({
    entries: {
      "agent:main:subagent:visible-parent": {
        sessionId: "sess-visible-parent",
        updatedAt: now - 3_000,
        spawnedBy: "agent:main:main",
      },
      "agent:main:subagent:hidden-parent": {
        sessionId: "sess-hidden-parent",
        updatedAt: now - 2_000,
        spawnedBy: "agent:main:main",
      },
      "agent:main:subagent:shared-child-key-filter": {
        sessionId: "sess-shared-child-key-filter",
        updatedAt: now - 1_000,
        spawnedBy: "agent:main:subagent:hidden-parent",
      },
    },
  });

  const { ws } = await openClient();
  const resolved = await rpcReq(ws, "sessions.resolve", {
    key: "agent:main:subagent:shared-child-key-filter",
    spawnedBy: "agent:main:subagent:visible-parent",
  });

  expect(resolved.ok).toBe(false);
  expect(resolved.error?.message).toContain(
    "No session found: agent:main:subagent:shared-child-key-filter",
  );
});
