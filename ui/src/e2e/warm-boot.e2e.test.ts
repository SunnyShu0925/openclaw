import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect as expectPage } from "playwright/test";
import { expect, it } from "vitest";
import type { ApplicationRuntime } from "../app/bootstrap.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI warm reload",
  trackBrowserContexts: true,
});
const sessionKey = "agent:main:main";
const transcriptText = "This conversation is ready before the Gateway reconnects.";

function attributedMessage(id: string, name: string, text: string, seq: number) {
  return {
    role: "user",
    content: text,
    __openclaw: {
      id: `message-${id}`,
      seq,
      senderId: id,
      senderIdentity: { type: "profile", id },
      senderName: name,
    },
  };
}

async function expectSender(page: Page, text: string, name: string, peer: boolean) {
  const group = page.locator(".chat-group.user", { hasText: text });
  await page.mouse.move(0, 0);
  await page.locator(".agent-chat__composer-combobox textarea").focus();
  await expect
    .poll(() => group.evaluate((row) => row.classList.contains("chat-group--peer")))
    .toBe(peer);
  await expectPage(group).toHaveCSS("justify-content", peer ? "start" : "end");
  await expectPage(group.locator(".chat-sender-name")).toHaveText(name);
  await expectPage(group.locator(".chat-group-footer")).toHaveCSS("opacity", "1");
  return group;
}

async function waitForPersistedWarmState(page: Page, eligible = true): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const hasBootRecord = Object.keys(localStorage).some((key) =>
          key.startsWith("openclaw.control.bootRecord.v1:"),
        );
        const databases = await indexedDB.databases();
        async function readRecords(databaseName: string, storeName: string): Promise<unknown[]> {
          if (!databases.some((database) => database.name === databaseName)) {
            return [];
          }
          return new Promise((resolve, reject) => {
            const open = indexedDB.open(databaseName);
            open.addEventListener("error", () =>
              reject(open.error ?? new Error("IndexedDB open failed")),
            );
            open.addEventListener("success", () => {
              const database = open.result;
              const transaction = database.transaction(storeName, "readonly");
              const request = transaction.objectStore(storeName).getAll();
              request.addEventListener("error", () =>
                reject(request.error ?? new Error("IndexedDB read failed")),
              );
              transaction.addEventListener("complete", () => {
                database.close();
                resolve(request.result);
              });
            });
          });
        }
        const [rosters, snapshots] = await Promise.all([
          readRecords("openclaw-session-roster", "rosters"),
          readRecords("openclaw-chat-snapshots", "snapshots"),
        ]);
        return {
          bootRecord: hasBootRecord,
          roster: rosters.some((record) => {
            if (typeof record !== "object" || record === null || !("result" in record)) {
              return false;
            }
            const result = record.result;
            return (
              typeof result === "object" &&
              result !== null &&
              "sessions" in result &&
              Array.isArray(result.sessions) &&
              result.sessions.some(
                (row: unknown) =>
                  typeof row === "object" &&
                  row !== null &&
                  "key" in row &&
                  row.key === "agent:main:cached-only",
              )
            );
          }),
          transcript: snapshots.some(
            (snapshot) =>
              typeof snapshot === "object" &&
              snapshot !== null &&
              "snapshot" in snapshot &&
              typeof snapshot.snapshot === "object" &&
              snapshot.snapshot !== null &&
              "deltaCursor" in snapshot.snapshot &&
              snapshot.snapshot.deltaCursor === "warm-reload-cursor",
          ),
        };
      }),
    )
    .toEqual({ bootRecord: eligible, roster: eligible, transcript: true });
}

suite.define(() => {
  it.each(["matching", "different", "device-token", "trusted-proxy"])(
    "reconciles the cached shell, roster, and transcript with a %s profile",
    async (profile) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const timestamp = Date.now();
        const currentRow = {
          key: sessionKey,
          sessionId: "warm-reload-session",
          kind: "direct" as const,
          label: "Warm reload conversation",
          updatedAt: timestamp,
        };
        const gateway = await installMockGateway(page, {
          // The typed hold applies again after reload and releases the normal hello payload.
          heldMethods: ["connect"],
          authMethod: profile === "trusted-proxy" || profile === "device-token" ? profile : "token",
          authMode: profile === "trusted-proxy" ? "trusted-proxy" : "token",
          presenceUsers: [
            {
              id: "profile-a",
              identity: { type: "profile", id: "profile-a" },
              name: "Morgan",
              self: true,
            },
          ],
          sessions: [
            currentRow,
            {
              key: "agent:main:cached-only",
              sessionId: "cached-only-session",
              kind: "direct",
              label: "Cached only session",
              updatedAt: timestamp - 1,
            },
          ],
          methodResponses: {
            "chat.startup": {
              sessionId: "warm-reload-session",
              sessionInfo: currentRow,
              messages: [
                attributedMessage("profile-a", "Morgan", "Morgan's saved message.", 1),
                attributedMessage("profile-b", "Riley", "Riley's saved message.", 2),
                {
                  role: "assistant",
                  content: transcriptText,
                  __openclaw: { id: "cached-message", seq: 3 },
                },
              ],
              deltaCursor: "warm-reload-cursor",
              hasMore: false,
              metadata: { models: [] },
            },
          },
        });
        await page.goto(
          controlUiSessionUrl(suite.server.baseUrl, sessionKey) +
            (profile === "device-token" ? "" : "#token=test-token"),
        );
        await gateway.waitForRequest("connect");
        await page.locator(".connect-splash").waitFor();
        await page.screenshot({ path: path.join(suite.artifactDir, "cold-connecting.png") });
        await gateway.resolveDeferred("connect");
        const sidebar = page.locator("openclaw-app-sidebar");
        const transcript = page.locator(".chat-thread-inner");
        await sidebar.getByText("Cached only session", { exact: true }).waitFor();
        await transcript.getByText(transcriptText, { exact: true }).waitFor();
        await expectSender(page, "Morgan's saved message.", "Morgan", false);
        await expectSender(page, "Riley's saved message.", "Riley", true);
        await waitForPersistedWarmState(page, profile !== "trusted-proxy");
        const hello = await page.evaluate(() => {
          const app = document.querySelector<HTMLElement & { runtime?: ApplicationRuntime }>(
            "openclaw-app",
          );
          const snapshot = app?.runtime?.context.gateway.snapshot;
          if (snapshot?.selfUser?.id !== "profile-a" || !snapshot.hello) {
            throw new Error("Expected the first connection to belong to profile-a");
          }
          return snapshot.hello;
        });

        await page.reload();
        const connect = await gateway.waitForRequest("connect");
        if (profile === "trusted-proxy") {
          await page.locator(".connect-splash").waitFor();
          expect(await page.locator("openclaw-app-shell").count()).toBe(0);
          expect(await sidebar.getByText("Cached only session", { exact: true }).count()).toBe(0);
          expect(await transcript.getByText(transcriptText, { exact: true }).count()).toBe(0);
          expect(await gateway.getRequests("sessions.list")).toEqual([]);
          expect(await gateway.getRequests("chat.startup")).toEqual([]);
          await waitForPersistedWarmState(page, false);
          await page.screenshot({ path: path.join(suite.artifactDir, "proxy-before-hello.png") });
          await gateway.resolveDeferred("connect");
          await transcript.getByText(transcriptText, { exact: true }).waitFor();
          await waitForPersistedWarmState(page, false);
          return;
        }
        await sidebar.locator(".nav-item--home").waitFor();
        await sidebar.getByText("Cached only session", { exact: true }).waitFor();
        await transcript.getByText(transcriptText, { exact: true }).waitFor();
        expect(await gateway.getRequests("sessions.list")).toEqual([]);
        expect(await gateway.getRequests("chat.startup")).toEqual([]);
        await expectSender(page, "Morgan's saved message.", "Morgan", false);
        const unresolvedPeer = await expectSender(page, "Riley's saved message.", "Riley", false);
        await expectPage(
          unresolvedPeer.locator(".chat-group-footer .chat-author-avatar"),
        ).toBeVisible();
        await page.screenshot({
          path: path.join(suite.artifactDir, `warm-${profile}-before-hello.png`),
        });

        await gateway.setSessionsListResponse({
          ts: timestamp + 1,
          path: "",
          count: 2,
          defaults: { model: null, modelProvider: null, contextTokens: null },
          sessions: [
            { ...currentRow, label: "Live reload conversation", updatedAt: timestamp + 1 },
            {
              key: "agent:main:live-only",
              sessionId: "live-only-session",
              kind: "direct",
              label: "Live only session",
              updatedAt: timestamp,
            },
          ],
        });
        await gateway.setMethodResponse("chat.startup", {
          kind: "delta",
          messages: [],
          deltaCursor: "warm-reload-next-cursor",
          sessionInfo: currentRow,
          metadata: { models: [] },
        });
        if (profile === "different") {
          const client = isRecord(connect.params) ? connect.params.client : null;
          if (!isRecord(client) || typeof client.instanceId !== "string") {
            throw new Error("Expected a client instance ID in the connect request");
          }
          await gateway.deferNext("chat.startup");
          await gateway.resolveDeferred("connect", {
            ...hello,
            snapshot: {
              ...(typeof hello.snapshot === "object" && hello.snapshot !== null
                ? hello.snapshot
                : {}),
              presence: [
                {
                  instanceId: client.instanceId,
                  reason: "connect",
                  user: {
                    id: "profile-b",
                    identity: { type: "profile", id: "profile-b" },
                    name: "Riley",
                  },
                },
              ],
            },
          });
        } else {
          await gateway.resolveDeferred("connect");
        }
        const startup = await gateway.waitForRequest("chat.startup");
        if (profile === "different") {
          expect(startup.params).toMatchObject({ sessionKey });
          expect(startup.params).not.toHaveProperty("cursor");
          await expect
            .poll(() => transcript.getByText(transcriptText, { exact: true }).count())
            .toBe(0);
          await gateway.resolveDeferred("chat.startup", {
            sessionId: "profile-b-session",
            sessionInfo: { ...currentRow, sessionId: "profile-b-session" },
            messages: [
              attributedMessage("profile-a", "Morgan", "Morgan's replacement message.", 1),
              attributedMessage("profile-b", "Riley", "Riley's replacement message.", 2),
              { role: "assistant", content: "This is profile B's conversation." },
            ],
            hasMore: false,
            deltaCursor: "profile-b-cursor",
            metadata: { models: [] },
          });
        } else {
          expect(startup.params).toMatchObject({ sessionKey, cursor: "warm-reload-cursor" });
        }
        await gateway.waitForRequest("sessions.list");
        await sidebar.locator(".nav-item--home").waitFor();
        await sidebar.getByText("Live only session", { exact: true }).waitFor();
        expect(await sidebar.getByText("Cached only session", { exact: true }).count()).toBe(0);
        await transcript
          .getByText(
            profile === "different" ? "This is profile B's conversation." : transcriptText,
            { exact: true },
          )
          .waitFor();
        const replaced = profile === "different";
        const morganText = replaced ? "Morgan's replacement message." : "Morgan's saved message.";
        const rileyText = replaced ? "Riley's replacement message." : "Riley's saved message.";
        await expectSender(page, morganText, "Morgan", replaced);
        const resolvedPeer = await expectSender(page, rileyText, "Riley", !replaced);
        await expectPage(
          resolvedPeer.locator(
            ".chat-message-avatar-anchor > :is(.chat-avatar, .chat-avatar-slot)",
          ),
        ).toBeVisible();
        await resolvedPeer.hover();
        await resolvedPeer.getByRole("button", { name: "Reply to message" }).click();
        await expectPage(page.locator(".chat-reply-preview__label")).toHaveText(
          "Replying to Riley",
        );
        await page.locator(".chat-reply-preview__dismiss").click();
        await page.screenshot({
          path: path.join(suite.artifactDir, `warm-${profile}-after-hello.png`),
        });

        if (profile !== "matching") {
          return;
        }
        let connectCount = (await gateway.getRequests("connect")).length;
        let startupCount = (await gateway.getRequests("chat.startup")).length;
        await gateway.deferNext("connect");
        await gateway.closeLatest(1001, "Identity reconnect");
        await gateway.waitForRequest("connect", { after: connectCount });
        await expectSender(page, morganText, "You", false);
        const retainedPeer = await expectSender(page, rileyText, "Riley", true);
        await expectPage(
          retainedPeer.locator(
            ".chat-message-avatar-anchor > :is(.chat-avatar, .chat-avatar-slot)",
          ),
        ).toBeVisible();
        await gateway.resolveDeferred("connect");
        await gateway.waitForRequest("chat.startup", { after: startupCount });
        await expectSender(page, morganText, "Morgan", false);
        await expectSender(page, rileyText, "Riley", true);
        const newPeer = attributedMessage("profile-c", "Casey", "Casey joined after reconnect.", 4);
        await gateway.emitGatewayEvent("session.message", {
          sessionKey,
          messageId: newPeer.__openclaw.id,
          messageSeq: newPeer.__openclaw.seq,
          message: newPeer,
        });
        await expectSender(page, newPeer.content, "Casey", true);

        connectCount = (await gateway.getRequests("connect")).length;
        startupCount = (await gateway.getRequests("chat.startup")).length;
        await gateway.setMethodResponse("chat.startup", {
          sessionId: currentRow.sessionId,
          sessionInfo: currentRow,
          messages: [
            attributedMessage("profile-a", "Morgan", morganText, 1),
            attributedMessage("profile-b", "Riley", rileyText, 2),
            newPeer,
          ],
          hasMore: false,
          deltaCursor: "replacement-account-cursor",
          metadata: { models: [] },
        });
        await gateway.deferNext("connect");
        await gateway.closeLatest(1001, "Account replacement");
        const replacementConnect = await gateway.waitForRequest("connect", { after: connectCount });
        const client = isRecord(replacementConnect.params)
          ? replacementConnect.params.client
          : null;
        if (!isRecord(client) || typeof client.instanceId !== "string") {
          throw new Error("Expected a client instance ID in the replacement connect request");
        }
        await gateway.resolveDeferred("connect", {
          ...hello,
          snapshot: {
            ...hello.snapshot,
            presence: [
              {
                instanceId: client.instanceId,
                reason: "connect",
                user: {
                  id: "profile-b",
                  identity: { type: "profile", id: "profile-b" },
                  name: "Riley",
                },
              },
            ],
          },
        });
        const replacementStartup = await gateway.waitForRequest("chat.startup", {
          after: startupCount,
        });
        expect(replacementStartup.params).not.toHaveProperty("cursor");
        await expectSender(page, morganText, "Morgan", true);
        await expectSender(page, rileyText, "Riley", false);
        await expectSender(page, newPeer.content, "Casey", true);

        await page.evaluate(() => {
          const app = document.querySelector<HTMLElement & { runtime?: ApplicationRuntime }>(
            "openclaw-app",
          );
          app!.runtime!.context.navigate("connection");
        });
        const connection = page.locator("openclaw-connection-page");
        const replacementUrl = "ws://127.0.0.1:19998";
        await connection.getByLabel("Gateway URL", { exact: true }).fill(replacementUrl);
        await connection.getByRole("button", { name: "Apply and reconnect", exact: true }).click();
        await connection.getByText("Connected", { exact: true }).waitFor();
        expect((await gateway.getSocketUrls()).at(-1)).toBe(replacementUrl);
        await page.evaluate(
          (pathname) => {
            const app = document.querySelector<HTMLElement & { runtime?: ApplicationRuntime }>(
              "openclaw-app",
            );
            app!.runtime!.context.navigate("chat", { pathname });
          },
          new URL(controlUiSessionUrl(suite.server.baseUrl, sessionKey)).pathname,
        );
        await expectSender(page, morganText, "Morgan", false);
        await expectSender(page, rileyText, "Riley", true);
        await expectSender(page, newPeer.content, "Casey", true);
      });
    },
  );
});
