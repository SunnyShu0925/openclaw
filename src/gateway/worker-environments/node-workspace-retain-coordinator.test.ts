import { describe, expect, it, vi } from "vitest";
import { NODE_WORKER_WORKSPACE_RETAIN_COMMAND } from "../../infra/node-commands.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import {
  NODE_WORKER_BUNDLE_RETAIN_MAX_HASHES,
  NODE_WORKER_RETAIN_REQUEST_MAX_BYTES,
} from "../../worker/node-workspace-retain-protocol.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import { createNodeWorkspaceRetainCoordinator } from "./node-workspace-retain-coordinator.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerEnvironmentService } from "./service.js";

type NodeWorkerBundleStatusObservation = NonNullable<
  ReturnType<NonNullable<NodeWorkerSupervisorTransport["getBundleStatus"]>>
>;

const node = {
  nodeId: "node-1",
  connId: "connection-1",
  pairingIdentity: "pairing-1",
  pairingGeneration: "generation-1",
  clientId: "node-host",
  clientMode: "node",
  protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
  workerHost: {
    enabled: true,
    capacity: "available",
    bundleRetention: 1,
    bundleStatus: 1,
  },
  commands: [],
} as const;

function environment(overrides: Record<string, unknown> = {}) {
  return {
    environmentId: "environment-1",
    providerId: "device",
    profileId: "device:node-1",
    profileSnapshot: { install: "bundle", settings: { device: "node-1" } },
    provisionOperationId: "provision-1",
    nodeSetupId: null,
    nodeDeviceId: "node-1",
    sharedHost: true,
    desktop: null,
    bootstrapReceipt: null,
    ownerEpoch: 7,
    teardownTerminalState: null,
    attachedSessionIds: ["session-1"],
    lastError: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
    idleSinceAtMs: null,
    destroyRequestedAtMs: null,
    state: "attached",
    leaseId: "device-lease",
    sshEndpoint: null,
    desktopAvailable: false,
    desktopApps: [],
    tunnelStatus: "connected",
    ...overrides,
  };
}

function placement(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-1",
    agentId: "main",
    sessionKey: "agent:main:session-1",
    generation: 3,
    turnClaim: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
    state: "active",
    environmentId: "environment-1",
    activeOwnerEpoch: 7,
    workspaceBaseManifestRef: `sha256:${"a".repeat(64)}`,
    remoteWorkspaceDir: "/node/workspace",
    workerBundleHash: "b".repeat(64),
    lastTranscriptAckCursor: null,
    lastLiveEventAckCursor: null,
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
    ...overrides,
  };
}

function createHarness(
  params: {
    environments?: unknown[];
    placements?: unknown[];
    results?: Array<{
      applied: boolean;
      deleted: number;
      hasMore: boolean;
      bundleDeleted?: number;
      bundleGeneration?: number;
      bundleStatus?: { bundleHash: string; status: "installed" | "missing" };
    }>;
    node?: NodeWorkerSupervisorNodeProof;
    currentBundleStatus?: NodeWorkerBundleStatusObservation;
    invokeError?: string;
    onInvoke?: (index: number) => void;
    loop?: { applied: boolean; deleted: number; hasMore: boolean; bundleDeleted?: number };
  } = {},
) {
  const results = [...(params.results ?? [{ applied: true, deleted: 0, hasMore: false }])];
  const loopResult = params.loop;
  let invokeIndex = 0;
  const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async () => {
    params.onInvoke?.(invokeIndex++);
    if (params.invokeError) {
      return { ok: false, error: { code: "UNAVAILABLE", message: params.invokeError } };
    }
    return {
      ok: true,
      payloadJSON: JSON.stringify(
        loopResult ?? results.shift() ?? { applied: true, deleted: 0, hasMore: false },
      ),
    };
  });
  let currentBundleStatus = params.currentBundleStatus;
  const acceptBundleStatus = vi.fn(
    (
      _node: NodeWorkerSupervisorNodeProof,
      observation: NodeWorkerBundleStatusObservation | undefined,
    ) => {
      currentBundleStatus = observation;
      return true;
    },
  );
  const transport: NodeWorkerSupervisorTransport = {
    listCurrentNodes: async () => [params.node ?? node],
    getBundleStatus: () => currentBundleStatus,
    acceptBundleStatus,
    isCurrent: () => true,
    invoke,
  };
  const warn = vi.fn();
  const coordinator = createNodeWorkspaceRetainCoordinator({
    gatewayNamespace: "gateway-test",
    environments: {
      list: () => (params.environments ?? [environment()]) as never,
    } as Pick<WorkerEnvironmentService, "list">,
    placements: {
      list: () => (params.placements ?? [placement()]) as never,
    } as Pick<WorkerSessionPlacementStore, "list">,
    warn,
  });
  coordinator.bindTransport(transport);
  return { coordinator, invoke, warn, acceptBundleStatus };
}

describe("node workspace retain coordinator", () => {
  it("publishes the complete durable retain snapshot for a connected device", async () => {
    const { coordinator, invoke } = createHarness({
      environments: [
        environment(),
        environment({
          environmentId: "environment-other",
          nodeDeviceId: "node-other",
          profileSnapshot: { settings: { device: "node-other" } },
        }),
        environment({ environmentId: "environment-terminal", state: "orphaned" }),
      ],
    });

    await coordinator.start();

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      node,
      command: NODE_WORKER_WORKSPACE_RETAIN_COMMAND,
      params: {
        version: 1,
        gatewayNamespace: "gateway-test",
        controllerId: expect.any(String),
        sequence: 1,
        bundleHashes: ["b".repeat(64)],
        retain: [
          {
            environmentId: "environment-1",
            sessionId: "session-1",
            generation: 7,
            manifestRefs: [`sha256:${"a".repeat(64)}`],
          },
        ],
      },
    });
    await coordinator.stop();
  });

  it("keeps prior retention nodes compatible without sending a status query", async () => {
    const { coordinator, invoke, acceptBundleStatus } = createHarness({
      node: {
        ...node,
        workerHost: {
          enabled: true,
          capacity: "available",
          bundleRetention: 1,
        },
      },
      environments: [
        environment({
          bootstrapReceipt: {
            bundleHash: "b".repeat(64),
            openclawVersion: "2026.8.9",
            protocolFeatures: [],
            installKind: "bundle",
          },
        }),
      ],
    });

    await coordinator.start();

    expect(invoke.mock.calls[0]?.[0].params).toMatchObject({
      bundleHashes: ["b".repeat(64)],
    });
    expect(invoke.mock.calls[0]?.[0].params).not.toHaveProperty("bundleStatusHash");
    expect(acceptBundleStatus).toHaveBeenCalledWith(expect.any(Object), undefined);
    await coordinator.stop();
  });

  it("accepts a validated installed bundle status with the Gateway-owned version", async () => {
    const bundleHash = "b".repeat(64);
    const { coordinator, invoke, acceptBundleStatus } = createHarness({
      currentBundleStatus: {
        bundleHash,
        status: { status: "installed", version: "2026.8.9" },
      },
      environments: [
        environment({
          bootstrapReceipt: {
            bundleHash,
            openclawVersion: "2026.8.9",
            protocolFeatures: [],
            installKind: "bundle",
          },
        }),
      ],
      results: [
        {
          applied: true,
          deleted: 0,
          hasMore: false,
          bundleGeneration: 3,
          bundleStatus: { bundleHash, status: "installed" },
        },
      ],
    });

    await coordinator.start();

    expect(invoke.mock.calls[0]?.[0].params).toMatchObject({ bundleStatusHash: bundleHash });
    expect(acceptBundleStatus).toHaveBeenCalledWith(node, {
      bundleHash,
      status: { status: "installed", version: "2026.8.9" },
    });
    await coordinator.stop();
  });

  it("accepts status only from the final pass for the exact requested hash", async () => {
    const bundleHash = "b".repeat(64);
    const { coordinator, acceptBundleStatus } = createHarness({
      environments: [
        environment({
          bootstrapReceipt: {
            bundleHash,
            openclawVersion: "2026.8.9",
            protocolFeatures: [],
            installKind: "bundle",
          },
        }),
      ],
      results: [
        {
          applied: true,
          deleted: 1,
          hasMore: true,
          bundleStatus: { bundleHash, status: "installed" },
        },
        {
          applied: true,
          deleted: 0,
          hasMore: false,
          bundleStatus: { bundleHash, status: "missing" },
        },
      ],
    });

    await coordinator.start();

    expect(acceptBundleStatus).toHaveBeenCalledTimes(1);
    expect(acceptBundleStatus).toHaveBeenCalledWith(node, {
      bundleHash,
      status: { status: "missing" },
    });
    await coordinator.stop();
  });

  it("clears the previous hash before a new authoritative inspection can fail", async () => {
    const previousHash = "b".repeat(64);
    const currentHash = "c".repeat(64);
    const { coordinator, acceptBundleStatus, warn } = createHarness({
      currentBundleStatus: {
        bundleHash: previousHash,
        status: { status: "installed", version: "2026.8.8" },
      },
      environments: [
        environment({
          bootstrapReceipt: {
            bundleHash: currentHash,
            openclawVersion: "2026.8.9",
            protocolFeatures: [],
            installKind: "bundle",
          },
        }),
      ],
      invokeError: "maintenance unavailable",
    });

    await coordinator.start();

    expect(acceptBundleStatus).toHaveBeenCalledWith(node, undefined);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("maintenance unavailable"));
    await coordinator.stop();
  });

  it("clears status when a newer environment becomes authoritative during cleanup", async () => {
    const bundleHash = "b".repeat(64);
    const environments = [
      environment({
        bootstrapReceipt: {
          bundleHash,
          openclawVersion: "2026.8.9",
          protocolFeatures: [],
          installKind: "bundle",
        },
      }),
    ];
    const { coordinator, acceptBundleStatus } = createHarness({
      environments,
      results: [
        {
          applied: true,
          deleted: 1,
          hasMore: true,
          bundleStatus: { bundleHash, status: "installed" },
        },
        {
          applied: true,
          deleted: 0,
          hasMore: false,
          bundleStatus: { bundleHash, status: "installed" },
        },
      ],
      onInvoke: (index) => {
        if (index !== 0) {
          return;
        }
        environments.splice(
          0,
          1,
          environment({
            environmentId: "environment-new",
            createdAtMs: 3,
            bootstrapReceipt: {
              bundleHash: "c".repeat(64),
              openclawVersion: "2026.8.10",
              protocolFeatures: [],
              installKind: "bundle",
            },
          }),
        );
      },
    });

    await coordinator.start();

    expect(acceptBundleStatus).toHaveBeenCalledTimes(1);
    expect(acceptBundleStatus).toHaveBeenCalledWith(node, undefined);
    await coordinator.stop();
  });

  it("clears status when the node echoes a different bundle hash", async () => {
    const bundleHash = "b".repeat(64);
    const { coordinator, acceptBundleStatus } = createHarness({
      environments: [
        environment({
          bootstrapReceipt: {
            bundleHash,
            openclawVersion: "2026.8.9",
            protocolFeatures: [],
            installKind: "bundle",
          },
        }),
      ],
      results: [
        {
          applied: true,
          deleted: 0,
          hasMore: false,
          bundleStatus: { bundleHash: "c".repeat(64), status: "installed" },
        },
      ],
    });

    await coordinator.start();

    expect(acceptBundleStatus).toHaveBeenCalledWith(node, undefined);
    await coordinator.stop();
  });

  it("keeps workspace retention compatible when bundle cleanup is not advertised", async () => {
    const { coordinator, invoke } = createHarness({
      node: {
        ...node,
        workerHost: { enabled: true, capacity: "available" },
      },
    });

    await coordinator.start();

    expect(invoke.mock.calls[0]?.[0].params).not.toHaveProperty("bundleHashes");
    await coordinator.stop();
  });

  it("fails safe to workspace-only retention when bundle ownership exceeds the wire bound", async () => {
    const environments = Array.from(
      { length: NODE_WORKER_BUNDLE_RETAIN_MAX_HASHES + 1 },
      (_, index) =>
        environment({
          environmentId: `environment-${index}`,
          attachedSessionIds: [],
          bootstrapReceipt: {
            bundleHash: index.toString(16).padStart(64, "0"),
            openclawVersion: "2026.8.1",
            protocolFeatures: [],
            installKind: "bundle",
          },
        }),
    );
    const { coordinator, invoke, warn } = createHarness({ environments, placements: [] });

    await coordinator.start();

    expect(invoke.mock.calls[0]?.[0].params).not.toHaveProperty("bundleHashes");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("exceed the bounded maintenance request"),
    );
    await coordinator.stop();
  });

  it("keeps bounded bundle retention when only the status query exceeds one MiB", async () => {
    const attachedCount = 1_241;
    const environments = Array.from(
      { length: NODE_WORKER_BUNDLE_RETAIN_MAX_HASHES },
      (_, index) => {
        const suffix = index.toString(16).padStart(8, "0");
        const attached = index < attachedCount;
        const environmentPadding =
          index < attachedCount - 1 ? 220 : index === attachedCount - 1 ? 31 : 0;
        const sessionPadding =
          index < attachedCount - 1 ? 224 : index === attachedCount - 1 ? 31 : 0;
        return environment({
          environmentId: `environment-${"e".repeat(environmentPadding)}-${suffix}`,
          attachedSessionIds: attached ? [`session-${"s".repeat(sessionPadding)}-${suffix}`] : [],
          createdAtMs: index === NODE_WORKER_BUNDLE_RETAIN_MAX_HASHES - 1 ? 10 : 1,
          bootstrapReceipt: {
            bundleHash: index.toString(16).padStart(64, "0"),
            openclawVersion: "2026.8.9",
            protocolFeatures: [],
            installKind: "bundle",
          },
        });
      },
    );
    const placements = environments.slice(0, attachedCount).map((entry, index) =>
      placement({
        sessionId: entry.attachedSessionIds[0],
        environmentId: entry.environmentId,
        workerBundleHash: index.toString(16).padStart(64, "0"),
      }),
    );
    const { coordinator, invoke, warn } = createHarness({ environments, placements });

    await coordinator.start();

    const input = invoke.mock.calls[0]?.[0].params as Record<string, unknown>;
    expect(input.bundleHashes).toHaveLength(NODE_WORKER_BUNDLE_RETAIN_MAX_HASHES);
    expect(input).not.toHaveProperty("bundleStatusHash");
    expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBeLessThanOrEqual(
      NODE_WORKER_RETAIN_REQUEST_MAX_BYTES,
    );
    expect(
      Buffer.byteLength(
        JSON.stringify({
          ...input,
          bundleStatusHash: (NODE_WORKER_BUNDLE_RETAIN_MAX_HASHES - 1)
            .toString(16)
            .padStart(64, "0"),
        }),
        "utf8",
      ),
    ).toBeGreaterThan(NODE_WORKER_RETAIN_REQUEST_MAX_BYTES);
    expect(warn).not.toHaveBeenCalled();
    await coordinator.stop();
  });

  it("omits bundle hashes when the combined maintenance request exceeds one MiB", async () => {
    const environments = Array.from(
      { length: NODE_WORKER_BUNDLE_RETAIN_MAX_HASHES },
      (_, index) => {
        const suffix = index.toString(16).padStart(8, "0");
        const attached = index < 1_500;
        return environment({
          environmentId: `environment-${"e".repeat(220)}-${suffix}`,
          attachedSessionIds: attached ? [`session-${"s".repeat(224)}-${suffix}`] : [],
          bootstrapReceipt: {
            bundleHash: index.toString(16).padStart(64, "0"),
            openclawVersion: "2026.8.1",
            protocolFeatures: [],
            installKind: "bundle",
          },
        });
      },
    );
    const placements = environments.slice(0, 1_500).map((entry, index) =>
      placement({
        sessionId: entry.attachedSessionIds[0],
        environmentId: entry.environmentId,
        workerBundleHash: index.toString(16).padStart(64, "0"),
      }),
    );
    const { coordinator, invoke, warn } = createHarness({ environments, placements });

    await coordinator.start();

    expect(invoke.mock.calls[0]?.[0].params).not.toHaveProperty("bundleHashes");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("exceed the bounded maintenance request"),
    );
    await coordinator.stop();
  });

  it("retains all manifests while the durable placement is incomplete", async () => {
    const { coordinator, invoke } = createHarness({ placements: [] });

    await coordinator.start();

    expect(invoke.mock.calls[0]?.[0].params).toMatchObject({
      retain: [expect.objectContaining({ manifestRefs: null })],
    });
    await coordinator.stop();
  });

  it("acknowledges the node bundle generation on the next same-connection snapshot", async () => {
    const { coordinator, invoke } = createHarness({
      results: [
        {
          applied: true,
          deleted: 0,
          hasMore: false,
          bundleGeneration: 7,
        },
        {
          applied: true,
          deleted: 0,
          hasMore: false,
          bundleGeneration: 7,
        },
      ],
    });

    await coordinator.start();
    await coordinator.schedule("node-1");

    expect(invoke.mock.calls[0]?.[0].params).not.toHaveProperty("acknowledgedBundleGeneration");
    expect(invoke.mock.calls[1]?.[0].params).toMatchObject({
      acknowledgedBundleGeneration: 7,
    });
    await coordinator.stop();
  });

  it("continues bounded node cleanup with the same snapshot sequence", async () => {
    const { coordinator, invoke } = createHarness({
      results: [
        { applied: true, deleted: 256, hasMore: true },
        { applied: true, deleted: 1, hasMore: false },
      ],
    });

    await coordinator.start();

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1]?.[0].params).toEqual(invoke.mock.calls[0]?.[0].params);
    await coordinator.stop();
  });

  it("republishes an identical full snapshot for reconnect-scoped inventory", async () => {
    const { coordinator, invoke } = createHarness();
    await coordinator.start();

    await coordinator.schedule("node-1");

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1]?.[0].params).toMatchObject({ sequence: 2 });
    await coordinator.stop();
  });

  it("aborts a node worker that never converges instead of looping forever (BUG-056)", async () => {
    // A buggy worker replies {applied:true, hasMore:true} without deleting.
    // Pre-fix the for(;;) loop never resolves; post-fix it bails after
    // MAX_CONSECUTIVE_NO_PROGRESS_RESPONSES replies and drain warns instead.
    const { coordinator, invoke, warn } = createHarness({
      loop: { applied: true, deleted: 0, hasMore: true },
    });

    await coordinator.start();

    // The constant is module-private (knip --production rejects unused
    // exports); keep this literal in sync with the source constant.
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("workspace retain did not converge"));
    await coordinator.stop();
  });

  it("preserves legitimate retain pagination beyond 100 pages", async () => {
    // A fixed 100-page cap would misclassify healthy backlogs above 25,600
    // stale entries; progressing pagination (deleted > 0 per round) must run
    // to hasMore:false regardless of page count.
    const results = Array.from({ length: 150 }, () => ({
      applied: true,
      deleted: 256,
      hasMore: true,
    }));
    results.push({ applied: true, deleted: 1, hasMore: false });
    const { coordinator, invoke, warn } = createHarness({ results });

    await coordinator.start();

    expect(invoke).toHaveBeenCalledTimes(151);
    expect(warn).not.toHaveBeenCalled();
    await coordinator.stop();
  });

  it("treats bundle-only deletion as forward progress (BUG-056 bundle lane)", async () => {
    // A legal bundle-only response carries { deleted: 0, hasMore: true,
    // bundleDeleted: >0 }: the workspace lane is already clean while bundle
    // cleanup still paginates (up to 16 candidates per page). The pre-fix
    // guard checked only `deleted`, so a healthy bundle backlog tripped the
    // no-progress detector after three rounds. Both lanes must count.
    const results = Array.from({ length: 10 }, () => ({
      applied: true,
      deleted: 0,
      hasMore: true,
      bundleDeleted: 16,
    }));
    results.push({ applied: true, deleted: 0, hasMore: false, bundleDeleted: 4 });
    const { coordinator, invoke, warn } = createHarness({ results });

    await coordinator.start();

    expect(invoke).toHaveBeenCalledTimes(11);
    expect(warn).not.toHaveBeenCalled();
    await coordinator.stop();
  });

  it("still converges when only the bundle lane makes progress across many pages", async () => {
    // Bundle cleanup deletes at most 16 candidates per page; a large bundle
    // backlog therefore requires many positive-progress responses. A buggy
    // 3-strike guard keyed on workspace `deleted` alone would abort this
    // healthy run after the third page.
    const results = Array.from({ length: 50 }, () => ({
      applied: true,
      deleted: 0,
      hasMore: true,
      bundleDeleted: 16,
    }));
    results.push({ applied: true, deleted: 0, hasMore: false, bundleDeleted: 3 });
    const { coordinator, invoke, warn } = createHarness({ results });

    await coordinator.start();

    expect(invoke).toHaveBeenCalledTimes(51);
    expect(warn).not.toHaveBeenCalled();
    await coordinator.stop();
  });

  it("still aborts when neither workspace nor bundle lane deletes (BUG-056)", async () => {
    // A genuinely stuck worker replies { deleted: 0, bundleDeleted: 0,
    // hasMore: true }; the converged guard must still trip after the limit.
    const { coordinator, invoke, warn } = createHarness({
      loop: { applied: true, deleted: 0, hasMore: true, bundleDeleted: 0 },
    });

    await coordinator.start();

    expect(invoke).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("workspace retain did not converge"));
    await coordinator.stop();
  });

  it("bounds a slow-but-progressing node worker with the convergence deadline", async () => {
    // A slow worker that always makes a little progress (deleted > 0) never
    // trips the no-progress detector, so the wall-clock deadline bounds it.
    // Fake timers advance the clock past the deadline between rounds.
    vi.useFakeTimers();
    const { coordinator, invoke, warn } = createHarness({
      loop: { applied: true, deleted: 1, hasMore: true },
    });
    try {
      invoke.mockImplementation(async () => {
        // Advance 20 minutes per round: round 1 stays inside the 30-minute
        // deadline, round 2 crosses it.
        vi.setSystemTime(Date.now() + 20 * 60_000);
        return {
          ok: true,
          payloadJSON: JSON.stringify({ applied: true, deleted: 1, hasMore: true }),
        };
      });

      await coordinator.start();

      expect(invoke).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("workspace retain did not converge"),
      );
      await coordinator.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps the in-flight RPC at the remaining convergence deadline", async () => {
    // An RPC begun just before expiry used to get a fresh 10-minute timeout.
    // The remaining budget must cap the final dispatch: after a 29-minute
    // first round, the second RPC gets 60s, not 600s.
    vi.useFakeTimers();
    const { coordinator, invoke, warn } = createHarness({
      loop: { applied: true, deleted: 1, hasMore: true },
    });
    try {
      let call = 0;
      invoke.mockImplementation(async () => {
        call += 1;
        vi.setSystemTime(Date.now() + (call === 1 ? 29 * 60_000 : 2 * 60_000));
        return {
          ok: true,
          payloadJSON: JSON.stringify({ applied: true, deleted: 1, hasMore: true }),
        };
      });

      await coordinator.start();

      expect(invoke).toHaveBeenCalledTimes(2);
      expect(invoke.mock.calls[0]?.[0].timeoutMs).toBe(10 * 60_000);
      expect(invoke.mock.calls[1]?.[0].timeoutMs).toBe(60_000);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("workspace retain did not converge within"),
      );
      await coordinator.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
