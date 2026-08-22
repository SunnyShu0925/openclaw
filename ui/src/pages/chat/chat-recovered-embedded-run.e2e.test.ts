/* @vitest-environment node */
// Real-browser Control UI proof on the current head: a channel-backed embedded
// run is recovered across reload (identity, elapsed timer, replayed activity)
// and Stop is routed through the session-owned abort path (sessions.abort),
// never through the browser-local chat.abort identity.
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { controlUiSessionUrl, installMockGateway } from "../../test-helpers/control-ui-e2e.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI recovered embedded run reload and Stop E2E",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed at ${executablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const sessionKey = "agent:main:main";
const runId = "recovered-embedded-run";
const startedAtMs = Date.now() - 30_000;

function sessionsListResponse() {
  const now = Date.now();
  return {
    count: 1,
    defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
    path: "",
    sessions: [{ key: sessionKey, kind: "direct", label: "Main session", updatedAt: now }],
    ts: now,
  };
}

async function parseWorkingSeconds(page: Page): Promise<number | null> {
  const text = (await page.locator("body").textContent()) ?? "";
  const match = text.match(/Working…\s*\n?\s*(\d+)\s*s/);
  return match ? Number(match[1]) : null;
}

async function readWorkingSeconds(page: Page): Promise<number | null> {
  await page.getByText("OpenClaw is working...").first().waitFor({ state: "visible" });
  return parseWorkingSeconds(page);
}

suite.define(() => {
  it("recovers a channel-backed run across reload and routes Stop through sessions.abort", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey,
          historyMessages: [
            {
              content: [{ type: "text", text: "Recovered channel run." }],
              role: "user",
              timestamp: startedAtMs - 30_000,
            },
          ],
          methodResponses: { "sessions.list": sessionsListResponse() },
          // Production omits activeRunIds for embedded runs to preserve the
          // exact-chat-send identity contract; the recovery snapshot drives
          // UI adoption instead.
          sessionInfo: { hasActiveRun: true },
          inFlightRun: {
            runId,
            text: "",
            startedAt: startedAtMs,
            sessionAbortable: true,
            events: [
              {
                runId,
                seq: 1,
                stream: "tool",
                ts: startedAtMs + 1_000,
                data: { phase: "start", name: "read_file", args: { path: "evidence.txt" } },
              },
              {
                runId,
                seq: 2,
                stream: "item",
                ts: startedAtMs + 2_000,
                data: {
                  kind: "preamble",
                  itemId: "preamble-1",
                  progressText: "Analyzing your request",
                },
              },
            ],
          },
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const beforeSeconds = await readWorkingSeconds(page);
        expect(beforeSeconds).not.toBeNull();

        await page.reload({ waitUntil: "load" });
        await page.getByText("OpenClaw is working...").first().waitFor({ state: "visible" });
        // The run-owned startedAt is fixed, so the displayed elapsed seconds
        // must strictly increase across reload. Poll instead of sampling once,
        // so a same-second reload cannot flake the assertion.
        await expect
          .poll(async () => parseWorkingSeconds(page), { timeout: 10_000, interval: 200 })
          .toBeGreaterThan(beforeSeconds ?? 0);

        // The recovered run's bounded activity is replayed in the UI.
        const afterText = (await page.locator("body").textContent()) ?? "";
        expect(afterText).toMatch(/Working…[\s\S]*?·\s*\S+/);
        // The recovered preamble item event is replayed as visible progress text.
        expect(afterText).toContain("Analyzing your request");

        // Stop stays on the session-owned abort route for recovered embedded runs.
        await page.getByRole("button", { name: "Stop" }).click();
        const abortRequest = await gateway.waitForRequest("sessions.abort");
        expect(abortRequest.params).toMatchObject({ key: sessionKey });
        const requests = await gateway.getRequests();
        expect(requests.some((request) => request.method === "chat.abort")).toBe(false);
        // The working indicator clears when the real gateway emits the run's
        // terminal lifecycle event; the mock gateway does not replay that event
        // stream, so the request-routing contract above is the Stop assertion.
      },
    );
  });
});
