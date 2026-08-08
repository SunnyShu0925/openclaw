/**
 * Bounded ordered candidate window for one ingress drain pass.
 *
 * A drain pass snapshots all pending events, then claims up to startLimit rows
 * in global order. Passing the full snapshot to claimNext on every claim made
 * claimNext re-read every candidate chunk twice (claimed pre-scan + pending
 * select) under the SQLite write lock, so a 33k-row backlog issued ~2,112
 * selects per 32-start pass. The window hands claimNext only a global-order
 * prefix of the snapshot, grows only when a claim returns null while rows still
 * remain outside it, and refreshes claimed-snapshot lanes once per attempt so
 * sibling-race lane checks survive without re-reading every chunk.
 */
import { resolveLaneKey } from "./ingress-drain-state.js";
import type {
  ChannelIngressQueue,
  ChannelIngressQueueClaim,
  ChannelIngressQueueRecord,
} from "./ingress-queue.js";

type IngressDrainCandidateWindow<TPayload, TMetadata> = {
  /** Current bounded candidate ids in global snapshot order (claimed rows removed). */
  ids: string[];
  /**
   * Run one claim attempt: refill the window, refresh sibling-race lanes, call
   * claimNext with the bounded ids, drop the claimed id, and widen the window
   * (bounded by the snapshot) when the claim returns null so a free row behind
   * any-size blocked prefix stays reachable. Returns null once the whole
   * snapshot has been scanned.
   */
  claimNextAttempt(
    options: Omit<
      NonNullable<Parameters<ChannelIngressQueue<TPayload, TMetadata>["claimNext"]>[0]>,
      "candidateIds"
    >,
  ): Promise<ChannelIngressQueueClaim<TPayload, TMetadata> | null>;
};

export function createIngressDrainCandidateWindow<TPayload, TMetadata>(options: {
  queue: ChannelIngressQueue<TPayload, TMetadata>;
  orderedCandidateIds: string[];
  blockedLaneKeys: Set<string>;
  scanLimit: number;
  deriveLaneKey?: (record: ChannelIngressQueueRecord<TPayload, TMetadata>) => string | undefined;
  reconcileStoredLaneKey?: (
    record: ChannelIngressQueueRecord<TPayload, TMetadata>,
    storedLaneKey: string,
    derivedLaneKey: string,
  ) => boolean;
}) {
  const {
    queue,
    orderedCandidateIds,
    blockedLaneKeys,
    scanLimit,
    deriveLaneKey,
    reconcileStoredLaneKey,
  } = options;
  const snapshotCandidateIds = new Set(orderedCandidateIds);
  const ids: string[] = [];
  let candidateWindowTarget = Math.max(1, scanLimit);
  let nextCandidateIndex = 0;
  const topUp = () => {
    while (ids.length < candidateWindowTarget && nextCandidateIndex < orderedCandidateIds.length) {
      const id = orderedCandidateIds[nextCandidateIndex];
      if (id === undefined) {
        break;
      }
      ids.push(id);
      nextCandidateIndex += 1;
    }
  };
  const grow = () => {
    if (nextCandidateIndex >= orderedCandidateIds.length) {
      return false;
    }
    candidateWindowTarget = Math.min(
      orderedCandidateIds.length,
      Math.max(candidateWindowTarget * 2, scanLimit),
    );
    return true;
  };
  const refreshClaimedLanes = async () => {
    const latestClaims = await queue.listClaims();
    for (const claim of latestClaims) {
      if (!snapshotCandidateIds.has(claim.id)) {
        continue;
      }
      const laneKey = resolveLaneKey(claim, deriveLaneKey, reconcileStoredLaneKey);
      if (laneKey) {
        blockedLaneKeys.add(laneKey);
      }
    }
  };
  const claimNextAttempt: IngressDrainCandidateWindow<
    TPayload,
    TMetadata
  >["claimNextAttempt"] = async (claimOptions) => {
    topUp();
    while (ids.length > 0) {
      await refreshClaimedLanes();
      const claimed = await queue.claimNext({ ...claimOptions, candidateIds: ids });
      if (claimed) {
        // Compact after a successful claim: drop the exhausted blocked prefix
        // (every id up to and including the claimed row was scanned this
        // attempt and the blocked set is effectively monotonic for the pass),
        // shrink the window back to the base target, and resume the ordered
        // snapshot just after the claimed row. Without this, a window widened
        // through a large blocked prefix would stay wide and replay nearly the
        // whole snapshot on every remaining start of the pass.
        ids.length = 0;
        nextCandidateIndex = orderedCandidateIds.indexOf(claimed.id) + 1;
        candidateWindowTarget = Math.max(1, scanLimit);
        return claimed;
      }
      if (!grow()) {
        break;
      }
      topUp();
    }
    return null;
  };
  return {
    ids,
    claimNextAttempt,
  };
}
