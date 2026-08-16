import { randomUUID } from "node:crypto";
import { NODE_WORKER_WORKSPACE_RETAIN_COMMAND } from "../../infra/node-commands.js";
import {
  NODE_WORKER_BUNDLE_RETENTION_VERSION,
  NODE_WORKER_BUNDLE_STATUS_VERSION,
} from "../../infra/node-runner-inventory.js";
import {
  NODE_WORKER_BUNDLE_RETAIN_MAX_HASHES,
  NODE_WORKER_RETAIN_REQUEST_MAX_BYTES,
  parseNodeWorkerWorkspaceRetainResult,
  type NodeWorkerWorkspaceRetainEntry,
  type NodeWorkerWorkspaceRetainInput,
} from "../../worker/node-workspace-retain-protocol.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerEnvironmentService } from "./service.js";
import { listRetainedWorkerBundleHashes } from "./worker-bundle-retention.js";

const RETAIN_COMMAND_TIMEOUT_MS = 10 * 60_000;
// BUG-056: a buggy worker may keep replying {applied:true, hasMore:true}.
// Healthy workers set hasMore only after deleting a full batch, so zero
// deletions mean no progress (bail after 3); a deadline bounds slow progress.
// Constants stay private so knip --production does not flag unused exports.
const MAX_CONSECUTIVE_NO_PROGRESS_RESPONSES = 3;
const RETAIN_CONVERGENCE_DEADLINE_MS = 3 * RETAIN_COMMAND_TIMEOUT_MS;
const TERMINAL_ENVIRONMENT_STATES = new Set(["destroyed", "failed", "orphaned"]);

type NodeWorkspaceRetainCoordinatorOptions = {
  gatewayNamespace: string;
  placements: Pick<WorkerSessionPlacementStore, "list">;
  environments: Pick<WorkerEnvironmentService, "list">;
  warn: (message: string) => void;
};

function nodeEnvironments(options: NodeWorkspaceRetainCoordinatorOptions, nodeId: string) {
  return options.environments.list().filter((environment) => environment.nodeDeviceId === nodeId);
}

function bundleStatusTargetForNode(options: NodeWorkspaceRetainCoordinatorOptions, nodeId: string) {
  return nodeEnvironments(options, nodeId)
    .filter(
      (environment) =>
        environment.bootstrapReceipt !== null &&
        !TERMINAL_ENVIRONMENT_STATES.has(environment.state),
    )
    .toSorted(
      (left, right) =>
        right.createdAtMs - left.createdAtMs ||
        left.environmentId.localeCompare(right.environmentId),
    )[0]?.bootstrapReceipt;
}

function snapshotBundleHashesForNode(
  options: NodeWorkspaceRetainCoordinatorOptions,
  nodeId: string,
): string[] {
  const environments = nodeEnvironments(options, nodeId);
  const environmentIds = new Set(environments.map((environment) => environment.environmentId));
  return listRetainedWorkerBundleHashes({
    environments,
    placements: options.placements
      .list()
      .filter(
        (placement) =>
          placement.environmentId !== null && environmentIds.has(placement.environmentId),
      ),
  });
}

function snapshotEntriesForNode(
  options: NodeWorkspaceRetainCoordinatorOptions,
  nodeId: string,
): NodeWorkerWorkspaceRetainEntry[] {
  const placements = new Map(
    options.placements.list().map((placement) => [placement.sessionId, placement] as const),
  );
  return nodeEnvironments(options, nodeId)
    .flatMap((environment): NodeWorkerWorkspaceRetainEntry[] => {
      if (
        TERMINAL_ENVIRONMENT_STATES.has(environment.state) ||
        environment.nodeDeviceId !== nodeId ||
        environment.attachedSessionIds.length !== 1
      ) {
        return [];
      }
      const sessionId = environment.attachedSessionIds[0]!;
      const placement = placements.get(sessionId);
      const hasExactManifestOwner =
        placement?.state === "starting" ||
        placement?.state === "active" ||
        placement?.state === "draining" ||
        placement?.state === "reconciling";
      const exactManifest =
        hasExactManifestOwner &&
        placement.environmentId === environment.environmentId &&
        placement.workspaceBaseManifestRef &&
        (placement.activeOwnerEpoch === environment.ownerEpoch || placement.state === "starting")
          ? [placement.workspaceBaseManifestRef]
          : null;
      return [
        {
          environmentId: environment.environmentId,
          sessionId,
          generation: environment.ownerEpoch,
          manifestRefs: exactManifest,
        },
      ];
    })
    .toSorted(
      (left, right) =>
        left.environmentId.localeCompare(right.environmentId) ||
        left.sessionId.localeCompare(right.sessionId) ||
        left.generation - right.generation,
    );
}

export function createNodeWorkspaceRetainCoordinator(
  options: NodeWorkspaceRetainCoordinatorOptions,
) {
  const controllerId = randomUUID();
  const abortController = new AbortController();
  const pendingNodes = new Set<string>();
  const acknowledgedBundleGenerationByNode = new Map<
    string,
    { connId: string; generation: number }
  >();
  let transport: NodeWorkerSupervisorTransport | undefined;
  let sequence = 0;
  let pendingAll = false;
  let operation: Promise<void> | undefined;
  let started = false;
  let stopped = false;

  const publishSnapshot = async (
    currentTransport: NodeWorkerSupervisorTransport,
    node: NodeWorkerSupervisorNodeProof,
  ): Promise<void> => {
    const retainedBundleHashes = snapshotBundleHashesForNode(options, node.nodeId);
    const bundleRetentionSupported =
      node.workerHost.bundleRetention === NODE_WORKER_BUNDLE_RETENTION_VERSION;
    const bundleStatusSupported =
      node.workerHost.bundleStatus === NODE_WORKER_BUNDLE_STATUS_VERSION;
    const baseInput: NodeWorkerWorkspaceRetainInput = {
      version: 1,
      gatewayNamespace: options.gatewayNamespace,
      controllerId,
      sequence: (sequence += 1),
      retain: snapshotEntriesForNode(options, node.nodeId),
    };
    const priorGeneration = acknowledgedBundleGenerationByNode.get(node.nodeId);
    const acknowledgedBundleGeneration =
      priorGeneration?.connId === node.connId ? priorGeneration.generation : undefined;
    const retentionInput: NodeWorkerWorkspaceRetainInput = {
      ...baseInput,
      bundleHashes: retainedBundleHashes,
      ...(acknowledgedBundleGeneration !== undefined ? { acknowledgedBundleGeneration } : {}),
    };
    const bundleHashesFit =
      retainedBundleHashes.length <= NODE_WORKER_BUNDLE_RETAIN_MAX_HASHES &&
      Buffer.byteLength(JSON.stringify(retentionInput), "utf8") <=
        NODE_WORKER_RETAIN_REQUEST_MAX_BYTES;
    const bundleStatusTarget = bundleStatusSupported
      ? bundleStatusTargetForNode(options, node.nodeId)
      : undefined;
    const statusInput =
      bundleStatusTarget && retainedBundleHashes.includes(bundleStatusTarget.bundleHash)
        ? { ...retentionInput, bundleStatusHash: bundleStatusTarget.bundleHash }
        : undefined;
    const statusInputFits =
      statusInput !== undefined &&
      Buffer.byteLength(JSON.stringify(statusInput), "utf8") <=
        NODE_WORKER_RETAIN_REQUEST_MAX_BYTES;
    const input =
      bundleRetentionSupported && bundleHashesFit
        ? statusInput && statusInputFits
          ? statusInput
          : retentionInput
        : baseInput;
    const previousBundleStatus = currentTransport.getBundleStatus?.(node.nodeId);
    if (
      !input.bundleStatusHash ||
      (previousBundleStatus && previousBundleStatus.bundleHash !== input.bundleStatusHash)
    ) {
      currentTransport.acceptBundleStatus?.(node, undefined);
    }
    if (bundleRetentionSupported && !bundleHashesFit) {
      options.warn(
        `Node bundle retention skipped (${node.nodeId}): ${retainedBundleHashes.length} retained hashes exceed the bounded maintenance request`,
      );
    }
    const convergenceDeadline = Date.now() + RETAIN_CONVERGENCE_DEADLINE_MS;
    let consecutiveNoProgressResponses = 0;
    for (;;) {
      // Cap each RPC timeout at the remaining convergence budget so an
      // in-flight call cannot hold the serialized coordinator past the deadline.
      const remainingBudget = convergenceDeadline - Date.now();
      if (remainingBudget <= 0) {
        throw new Error(
          `workspace retain did not converge within ${RETAIN_CONVERGENCE_DEADLINE_MS}ms (node worker is progressing too slowly)`,
        );
      }
      const result = await currentTransport.invoke({
        node,
        command: NODE_WORKER_WORKSPACE_RETAIN_COMMAND,
        params: input,
        timeoutMs: Math.min(RETAIN_COMMAND_TIMEOUT_MS, remainingBudget),
        signal: abortController.signal,
        isDispatchAuthorized: () => !stopped && transport === currentTransport,
      });
      if (!result.ok) {
        throw new Error(
          result.error?.message ??
            `workspace retain command failed (${result.error?.code ?? "unknown"})`,
        );
      }
      let payload: unknown;
      try {
        payload = result.payloadJSON ? (JSON.parse(result.payloadJSON) as unknown) : undefined;
      } catch {
        throw new Error("workspace retain command returned malformed JSON");
      }
      const retained = parseNodeWorkerWorkspaceRetainResult(payload);
      if (!retained) {
        throw new Error("workspace retain command violated its private result contract");
      }
      if (retained.applied && retained.bundleGeneration !== undefined) {
        acknowledgedBundleGenerationByNode.set(node.nodeId, {
          connId: node.connId,
          generation: retained.bundleGeneration,
        });
      }
      if (!retained.applied || !retained.hasMore) {
        const bundleStatus = retained.bundleStatus;
        const requestedBundleHash = input.bundleStatusHash;
        const currentStatusTarget = requestedBundleHash
          ? bundleStatusTargetForNode(options, node.nodeId)
          : undefined;
        const statusTargetMatches =
          currentStatusTarget != null &&
          requestedBundleHash !== undefined &&
          currentStatusTarget.bundleHash === requestedBundleHash;
        const statusMatches =
          retained.applied &&
          statusTargetMatches &&
          bundleStatus?.bundleHash === requestedBundleHash;
        if (statusMatches && currentStatusTarget && bundleStatus) {
          currentTransport.acceptBundleStatus?.(node, {
            bundleHash: currentStatusTarget.bundleHash,
            status:
              bundleStatus.status === "installed"
                ? { status: "installed", version: currentStatusTarget.openclawVersion }
                : { status: "missing" },
          });
        } else if (input.bundleStatusHash) {
          currentTransport.acceptBundleStatus?.(node, undefined);
        }
        return;
      }
      // hasMore:true is the healthy worker's normal pagination signal
      // (deleted >= 256 per batch); keep going while progress is made. Only
      // repeated zero-deletion hasMore replies violate the protocol; drain's
      // per-node catch warns and the next sweep retries.
      //
      // Progress is reported across two independent cleanup lanes — workspace
      // deletion (`deleted`) and bundle cleanup (`bundleDeleted`). A legal
      // bundle-only response carries { deleted: 0, hasMore: true, bundleDeleted: >0 },
      // so both counts must be considered: a response that deletes only bundles
      // is genuine forward progress and must not trip the no-progress guard.
      const totalDeleted = retained.deleted + (retained.bundleDeleted ?? 0);
      if (totalDeleted === 0) {
        consecutiveNoProgressResponses += 1;
        if (consecutiveNoProgressResponses >= MAX_CONSECUTIVE_NO_PROGRESS_RESPONSES) {
          throw new Error(
            `workspace retain did not converge: node worker returned hasMore:true without deleting stale entries ${MAX_CONSECUTIVE_NO_PROGRESS_RESPONSES} consecutive times`,
          );
        }
      } else {
        consecutiveNoProgressResponses = 0;
      }
    }
  };

  const drain = async (): Promise<void> => {
    while (pendingAll || pendingNodes.size > 0) {
      if (stopped) {
        return;
      }
      const reconcileAll = pendingAll;
      const requestedNodes = new Set(pendingNodes);
      pendingAll = false;
      pendingNodes.clear();
      const currentTransport = transport;
      if (!currentTransport) {
        continue;
      }
      let currentNodes: readonly NodeWorkerSupervisorNodeProof[];
      try {
        currentNodes = await currentTransport.listCurrentNodes();
      } catch (error) {
        options.warn(
          `Node workspace retain inventory failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      const targets = reconcileAll
        ? currentNodes
        : currentNodes.filter((node) => requestedNodes.has(node.nodeId));
      await Promise.all(
        targets.map(async (node) => {
          try {
            await publishSnapshot(currentTransport, node);
          } catch (error) {
            options.warn(
              `Node workspace retain publication failed (${node.nodeId}): ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }),
      );
    }
  };

  const schedule = (nodeId?: string): Promise<void> => {
    if (stopped) {
      return Promise.resolve();
    }
    if (nodeId) {
      pendingNodes.add(nodeId);
    } else {
      pendingAll = true;
    }
    if (!started) {
      return Promise.resolve();
    }
    if (operation) {
      return operation;
    }
    const current = drain().catch((error: unknown) => {
      options.warn(
        `Node workspace retain reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    const tracked = current.finally(() => {
      if (operation !== tracked) {
        return;
      }
      operation = undefined;
      if (!stopped && (pendingAll || pendingNodes.size > 0)) {
        void schedule();
      }
    });
    operation = tracked;
    return tracked;
  };

  return {
    bindTransport(next: NodeWorkerSupervisorTransport): void {
      transport = next;
      if (started) {
        void schedule();
      }
    },
    start(): Promise<void> {
      started = true;
      return schedule();
    },
    schedule,
    async stop(): Promise<void> {
      stopped = true;
      started = false;
      abortController.abort(new Error("node workspace retention stopped"));
      pendingAll = false;
      pendingNodes.clear();
      await operation;
    },
  };
}
