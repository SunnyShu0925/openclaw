/**
 * Shared sandbox backend registration contracts.
 *
 * Runtime creation and lifecycle cleanup stay behind this backend boundary.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SandboxBackendHandle } from "./backend-handle.types.js";
import type { SandboxRegistryEntry } from "./registry.js";
import type { SandboxConfig } from "./types.js";

/** Current runtime state reported by a sandbox backend manager. */
export type SandboxBackendRuntimeInfo = {
  running: boolean;
  actualConfigLabel?: string;
  configLabelMatch: boolean;
};

/** Optional lifecycle manager for an existing registered sandbox runtime. */
export type SandboxBackendManager = {
  describeRuntime(params: {
    entry: SandboxRegistryEntry;
    config: OpenClawConfig;
    agentId?: string;
  }): Promise<SandboxBackendRuntimeInfo>;
  removeRuntime(params: {
    entry: SandboxRegistryEntry;
    config: OpenClawConfig;
    agentId?: string;
  }): Promise<void>;
};

/** Inputs needed to create a sandbox backend handle for one session scope. */
export type CreateSandboxBackendParams = {
  sessionKey: string;
  scopeKey: string;
  /** Runtime IDs already registered for this backend and scope, newest first. */
  registeredRuntimeIds?: readonly string[];
  workspaceDir: string;
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  cfg: SandboxConfig;
  requireCurrentConfig?: boolean;
};

/** Factory that creates a backend handle for a sandbox session. */
export type SandboxBackendFactory = (
  params: CreateSandboxBackendParams,
) => Promise<SandboxBackendHandle>;

/** Resolve the runtime workdir without creating or starting the backend. */
export type SandboxBackendWorkdirResolver = (params: CreateSandboxBackendParams) => string;

/**
 * Canonical workspace target for gateway-owned inbound media staging.
 *
 * Inbound attachments are staged into the active sandbox workspace before an
 * agent run so the sandboxed agent can read them. A backend declares where its
 * canonical workspace lives so core staging writes through the right boundary
 * without constructing or registering the backend runtime as a side effect.
 *
 * Contract for backend authors:
 * - **Default is `"local"`.** Omit the field (or declare `"local"`) when the
 *   gateway-local workspace is canonical — i.e. the runtime reads staged files
 *   from a host-local directory that core can copy into directly. This is the
 *   Docker / podman / OpenShell mirror-mode case. Staging then uses host-local
 *   helpers and never provisions the backend.
 * - **Declare `"remote"` only when the canonical workspace is on the remote
 *   runtime**, not the gateway host. This is the SSH and OpenShell remote-mode
 *   case: after the initial seed the remote workspace is canonical, so a reused
 *   runtime only sees new attachments if they are written through the backend
 *   filesystem bridge. Declaring `"remote"` is a promise that the backend's
 *   resolved `SandboxFsBridge` can write staged bytes (with `mkdir: true`) into
 *   the remote workspace path returned by the workdir resolver.
 * - **Required bridge behavior for `"remote"`.** The bridge must accept the
 *   gateway-owned staging authority, create parent directories as needed, and
 *   preserve the existing protected-root and pinned-parent guards so a staged
 *   write can never resolve into a protected skill root. Staging reads the
 *   source through a bounded reader and writes at most
 *   `STAGED_MEDIA_MAX_BYTES`; the bridge must not introduce an unbounded copy.
 * - **No provisioning during staging.** Whichever value is declared, core
 *   staging must not start or construct a backend merely to decide the target;
 *   `"remote"` resolves the existing context's bridge, it does not create a
 *   runtime.
 *
 * Backends whose workspace is remote-canonical (SSH, and remote-mode
 * OpenShell) declare `"remote"` so core can stage attachments through the
 * backend filesystem bridge. Local-canonical backends (Docker, mirror-mode
 * OpenShell) keep the host-local copy path and are never provisioned during
 * staging.
 */
export type SandboxBackendCanonicalStaging = "local" | "remote";

/** Registry input accepted for sandbox backend registration. */
export type SandboxBackendRegistration =
  | SandboxBackendFactory
  | {
      factory: SandboxBackendFactory;
      manager?: SandboxBackendManager;
      resolveWorkdir?: SandboxBackendWorkdirResolver;
      /**
       * Declares where gateway-owned inbound media staging writes. Absent
       * means `"local"`: staging uses host-local helpers and must not
       * construct or register the backend runtime. See
       * {@link SandboxBackendCanonicalStaging} for the full contract
       * (local default, when to declare `"remote"`, and required bridge
       * behavior) before exporting a third-party remote-canonical backend.
       */
      canonicalStaging?: SandboxBackendCanonicalStaging;
    };

/** Normalized backend registration stored in the sandbox backend registry. */
export type RegisteredSandboxBackend = {
  factory: SandboxBackendFactory;
  manager?: SandboxBackendManager;
  resolveWorkdir?: SandboxBackendWorkdirResolver;
  canonicalStaging?: SandboxBackendCanonicalStaging;
};

export type { SandboxBackendHandle, SandboxBackendId } from "./backend-handle.types.js";
export type { SandboxBackendWorkdirValidation } from "./backend-handle.types.js";
