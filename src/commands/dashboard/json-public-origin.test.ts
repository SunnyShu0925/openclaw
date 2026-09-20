import { beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardCommand } from "../dashboard.js";
import { createTestRuntime } from "../test-runtime-config-helpers.js";

// The Control UI can be reached through a public origin while the Gateway itself
// listens on loopback. The one-time browser handoff must then name the origin the
// recipient can actually reach: a bind-derived loopback destination in the
// fragment disagrees with the served page's own origin, and the client treats that
// as "switch Gateway" before the pairing credential is applied.
//
// This lane keeps the real link resolution (`resolveControlUiLinks`) and the real
// handoff producer (`resolveControlUiHandoffTarget`, `issueControlUiBrowserHandoff`)
// and mocks only I/O: config read, port probe, bootstrap issuance and readiness.
const mocks = vi.hoisted(() => ({
  copyToClipboard: vi.fn(),
  ensureGatewayReadyForOperation: vi.fn(),
  inspectPortUsage: vi.fn(),
  issueDeviceBootstrapToken: vi.fn(),
  openUrl: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  resolveGatewayPort: vi.fn(),
  waitForControlUiDocument: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  resolveGatewayPort: mocks.resolveGatewayPort,
}));

vi.mock("../onboard-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../onboard-helpers.js")>()),
  detectBrowserOpenSupport: vi.fn(),
  openUrl: mocks.openUrl,
}));

vi.mock("../../infra/clipboard.js", () => ({
  copyToClipboard: mocks.copyToClipboard,
}));

vi.mock("../../infra/device-bootstrap.js", () => ({
  issueDeviceBootstrapToken: mocks.issueDeviceBootstrapToken,
}));

vi.mock("../../infra/ports-inspect.js", () => ({
  inspectPortUsage: mocks.inspectPortUsage,
}));

vi.mock("../gateway-readiness.js", () => ({
  ensureGatewayReadyForOperation: mocks.ensureGatewayReadyForOperation,
}));

vi.mock("../control-ui-handoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../control-ui-handoff.js")>()),
  waitForControlUiDocument: mocks.waitForControlUiDocument,
}));

const runtime = {
  ...createTestRuntime(),
  writeJson: vi.fn(),
  writeStdout: vi.fn(),
};

function readyDashboard(gateway: Record<string, unknown>): void {
  mocks.readConfigFileSnapshot.mockResolvedValue({
    valid: true,
    sourceConfig: { gateway },
  });
  mocks.resolveGatewayPort.mockReturnValue(18789);
  mocks.issueDeviceBootstrapToken.mockResolvedValue({
    token: "browser-bootstrap",
    expiresAtMs: 123_456,
  });
  mocks.inspectPortUsage.mockResolvedValue({
    port: 18789,
    status: "busy",
    listeners: [],
    hints: [],
  });
  mocks.ensureGatewayReadyForOperation.mockResolvedValue({
    ready: true,
    recovered: false,
    status: {},
  });
  mocks.waitForControlUiDocument.mockResolvedValue({ ready: true });
}

/** Read the fragment destination without asserting on the private payload type. */
function readHandoffGatewayUrl(): string | null {
  const payload: unknown = runtime.writeJson.mock.calls[0]?.[0];
  if (typeof payload !== "object" || payload === null || !("browserUrl" in payload)) {
    throw new Error("dashboard --json did not report a browserUrl");
  }
  const { browserUrl } = payload;
  if (typeof browserUrl !== "string") {
    throw new Error("dashboard --json reported a non-string browserUrl");
  }
  return new URLSearchParams(new URL(browserUrl).hash.slice(1)).get("gatewayUrl");
}

describe("dashboardCommand --json browser handoff destination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("names the configured public origin and base path so the pairing survives the proxy page", async () => {
    readyDashboard({
      bind: "loopback",
      controlUi: { basePath: "/dashboard" },
      publicOrigin: "https://public.example.com",
      auth: { token: "test" },
    });

    await dashboardCommand(runtime, { json: true, noOpen: true });

    expect(readHandoffGatewayUrl()).toBe("wss://public.example.com/dashboard");
  });

  it("omits gatewayUrl when no public origin is configured and the bind is loopback", async () => {
    readyDashboard({
      bind: "loopback",
      controlUi: { basePath: "/dashboard" },
      auth: { token: "test" },
    });

    await dashboardCommand(runtime, { json: true, noOpen: true });

    expect(readHandoffGatewayUrl()).toBeNull();
  });

  it("does not advertise a public destination while the Control UI is disabled", async () => {
    readyDashboard({
      bind: "loopback",
      controlUi: { enabled: false, basePath: "/dashboard" },
      publicOrigin: "https://public.example.com",
      auth: { token: "test" },
    });

    await dashboardCommand(runtime, { json: true, noOpen: true });

    // Control UI disabled -> resolveControlUiLinkLocation returns undefined ->
    // browserHandoffLinks falls back to bind-derived loopback -> gatewayUrl omitted.
    expect(readHandoffGatewayUrl()).toBeNull();
  });
});
