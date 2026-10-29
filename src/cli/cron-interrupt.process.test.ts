import { expect, it } from "vitest";
import type { WebSocket } from "ws";
import { getCliProcessTestTimeout } from "./cli-process-child.test-helpers.js";
import {
  prepareGatewayCliFixture,
  runIsolatedGatewayCli,
  tempDirs,
} from "./gateway-backed-exit.process.test-support.js";
import { startGateway } from "./gateway-backed-exit.test-helpers.js";

const TEST_TOKEN = "cron-interrupt-token";
const REQUEST_START_TIMEOUT_MS = 30_000;
const RPC_TIMEOUT_MS = 8_000;
const MUTATION_FAILURE = "automation store is read-only";

async function waitForRequest(calls: string[], method: string): Promise<void> {
  const deadlineAt = performance.now() + REQUEST_START_TIMEOUT_MS;
  while (!calls.includes(method)) {
    if (performance.now() > deadlineAt) {
      throw new Error(`CLI never issued ${method}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

// The accepted request is never answered, so only the CLI's interrupt custody can
// end the read.
it(
  "ends a pending cron inventory read on SIGINT without late output",
  async () => {
    const root = tempDirs.make("openclaw-cron-list-interrupt-");
    const gateway = await startGateway(
      () => {},
      () => ({
        methods: ["cron.list"],
        auth: { role: "operator", scopes: ["operator.admin"] },
      }),
    );
    const fixture = await prepareGatewayCliFixture(root, {
      mode: "remote",
      remote: { url: gateway.url, token: TEST_TOKEN },
    });

    let interruptedAt = 0;
    const result = await runIsolatedGatewayCli({
      args: [
        "cron",
        "list",
        "--url",
        gateway.url,
        "--token",
        TEST_TOKEN,
        "--timeout",
        String(RPC_TIMEOUT_MS),
        "--json",
      ],
      ...fixture,
      timeoutMs: getCliProcessTestTimeout(REQUEST_START_TIMEOUT_MS, RPC_TIMEOUT_MS),
      interact: async (child) => {
        await waitForRequest(gateway.calls, "cron.list");
        interruptedAt = performance.now();
        child.kill("SIGINT");
      },
    });
    const interruptedForMs = performance.now() - interruptedAt;

    expect(result.stdout).toBe("");
    expect(result.code).toBe(130);
    expect(result.stderr).not.toMatch(/timed out|The CLI command failed/u);
    // Waiting for the rejected request would take the whole RPC timeout.
    expect(interruptedForMs).toBeLessThan(RPC_TIMEOUT_MS);
  },
  getCliProcessTestTimeout(REQUEST_START_TIMEOUT_MS, RPC_TIMEOUT_MS) * 2,
);

it(
  "ends a pending cron show lookup on SIGINT without reporting a cancelled read",
  async () => {
    const root = tempDirs.make("openclaw-cron-show-interrupt-");
    const gateway = await startGateway(
      () => {},
      () => ({
        methods: ["cron.get"],
        auth: { role: "operator", scopes: ["operator.admin"] },
      }),
    );
    const fixture = await prepareGatewayCliFixture(root, {
      mode: "remote",
      remote: { url: gateway.url, token: TEST_TOKEN },
    });

    const result = await runIsolatedGatewayCli({
      args: [
        "cron",
        "show",
        "job-1",
        "--url",
        gateway.url,
        "--token",
        TEST_TOKEN,
        "--timeout",
        String(RPC_TIMEOUT_MS),
        "--json",
      ],
      ...fixture,
      timeoutMs: getCliProcessTestTimeout(REQUEST_START_TIMEOUT_MS, RPC_TIMEOUT_MS),
      interact: async (child) => {
        await waitForRequest(gateway.calls, "cron.get");
        child.kill("SIGINT");
      },
    });

    expect(result.stdout).toBe("");
    expect(result.code).toBe(130);
    expect(result.stderr).not.toMatch(/cron\.get|aborted|The CLI command failed/u);
  },
  getCliProcessTestTimeout(REQUEST_START_TIMEOUT_MS, RPC_TIMEOUT_MS) * 2,
);

// Mutations keep their lifetime through an interrupt, so a rejection that arrives
// afterwards is a real outcome and must still reach the operator.
it(
  "reports a rejected cron add that settles after SIGINT",
  async () => {
    const root = tempDirs.make("openclaw-cron-add-interrupt-");
    let pending: { ws: WebSocket; id: string } | undefined;
    const gateway = await startGateway(
      (ws, frame) => {
        if (frame.method === "cron.add") {
          pending = { ws, id: frame.id };
        }
      },
      () => ({
        methods: ["cron.add"],
        auth: { role: "operator", scopes: ["operator.admin"] },
      }),
    );
    const fixture = await prepareGatewayCliFixture(root, {
      mode: "remote",
      remote: { url: gateway.url, token: TEST_TOKEN },
    });

    const result = await runIsolatedGatewayCli({
      args: [
        "cron",
        "add",
        "interrupt-proof",
        "--message",
        "hello",
        "--every",
        "1h",
        "--no-deliver",
        "--url",
        gateway.url,
        "--token",
        TEST_TOKEN,
        "--timeout",
        String(RPC_TIMEOUT_MS),
        "--json",
      ],
      ...fixture,
      timeoutMs: getCliProcessTestTimeout(REQUEST_START_TIMEOUT_MS, RPC_TIMEOUT_MS),
      interact: async (child) => {
        await waitForRequest(gateway.calls, "cron.add");
        child.kill("SIGINT");
        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });
        const accepted = pending;
        if (!accepted) {
          throw new Error("cron.add was not accepted");
        }
        accepted.ws.send(
          JSON.stringify({
            type: "res",
            id: accepted.id,
            ok: false,
            error: { code: "INVALID_REQUEST", message: MUTATION_FAILURE },
          }),
        );
      },
    });

    expect(result.code).toBe(130);
    expect(`${result.stdout}${result.stderr}`).toContain(MUTATION_FAILURE);
  },
  getCliProcessTestTimeout(REQUEST_START_TIMEOUT_MS, RPC_TIMEOUT_MS) * 2,
);
