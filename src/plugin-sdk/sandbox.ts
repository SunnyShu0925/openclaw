/**
 * Public SDK subpath for sandbox backends, SSH execution, and temp workspace helpers.
 *
 * Backend registration contract: `SandboxBackendRegistration.canonicalStaging`
 * declares where gateway-owned inbound media staging writes. Third-party
 * backends default to `"local"` (host-local copy, no provisioning during
 * staging); declare `"remote"` only when the canonical workspace lives on the
 * remote runtime and the resolved `SandboxFsBridge` can write staged bytes into
 * it. See `SandboxBackendCanonicalStaging` for the full contract.
 */
export type {
  CreateSandboxBackendParams,
  RemoteShellSandboxHandle,
  RunSshSandboxCommandParams,
  SandboxBackendCanonicalStaging,
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  SandboxBackendExecSpec,
  SandboxBackendFactory,
  SandboxFsBridge,
  SandboxFsStat,
  SandboxBackendHandle,
  SandboxBackendId,
  SandboxBackendManager,
  SandboxBackendPreparedWorkdirDiscarder,
  SandboxBackendRegistration,
  SandboxBackendRuntimeInfo,
  SandboxBackendWorkdirValidation,
  SandboxBackendWorkdirResolver,
  SandboxBackendWorkdirValidator,
  SandboxContext,
  SandboxResolvedPath,
  SandboxSshConfig,
  SshSandboxSession,
  SshSandboxSettings,
} from "../agents/sandbox.js";
export type { OpenClawConfig } from "../config/config.js";

export {
  buildExecRemoteCommand,
  buildRemoteWorkdirValidationCommand,
  buildRemoteCommand,
  buildSshSandboxArgv,
  buildValidatedExecRemoteCommand,
  createRemoteShellSandboxFsBridge,
  createWritableRenameTargetResolver,
  createSshSandboxSessionFromConfigText,
  createSshSandboxSessionFromSettings,
  disposeSshSandboxSession,
  getSandboxBackendCanonicalStaging,
  getSandboxBackendFactory,
  getSandboxBackendManager,
  getSandboxBackendWorkdirResolver,
  isToolAllowed,
  registerSandboxBackend,
  requireSandboxBackendFactory,
  resolveSandboxRuntimeStatus,
  resolveWritableRenameTargets,
  resolveWritableRenameTargetsForBridge,
  runSshSandboxCommand,
  sanitizeEnvVars,
  shellEscape,
  uploadDirectoryToSshTarget,
} from "../agents/sandbox.js";

export {
  runPluginCommandWithTimeout,
  type PluginCommandRunOptions,
  type PluginCommandRunResult,
} from "./run-command.js";
export { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
export {
  tempWorkspace,
  tempWorkspaceSync,
  type TempWorkspace,
  type TempWorkspaceOptions,
  type TempWorkspaceSync,
  withTempWorkspace,
  withTempWorkspaceSync,
} from "../infra/private-temp-workspace.js";
