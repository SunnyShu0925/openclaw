import { hasMachineOutputOption } from "./machine-output-argv.js";
import { resolveModelsParentCommandPath } from "./parent-command-path.js";

/** Resolve the parent-command alias for `models status --json`. */
export function isModelsStatusJsonOutput(argv: readonly string[]): boolean {
  return (
    hasMachineOutputOption(argv, "--json") ||
    (resolveModelsParentCommandPath(argv)?.length === 1 &&
      hasMachineOutputOption(argv, "--status-json"))
  );
}

/**
 * Resolve whether a `models` command owns stdout as a plain machine-readable
 * stream. `list`/`status`/`aliases list`/`fallbacks list`/`image-fallbacks list`
 * advertise `--plain` line output, and the parent `--status-plain` alias mirrors
 * `models status --plain`. Startup diagnostics must route to stderr for these
 * modes just as they do for JSON, without turning plain failures into JSON.
 */
export function isModelsPlainMachineOutput(argv: readonly string[]): boolean {
  return (
    hasMachineOutputOption(argv, "--plain") ||
    (resolveModelsParentCommandPath(argv)?.length === 1 &&
      hasMachineOutputOption(argv, "--status-plain"))
  );
}
