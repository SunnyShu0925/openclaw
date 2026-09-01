// Reusable CLI error-message formatters that keep recovery hints consistent across commands.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatCliCommand } from "./command-format.js";

const DEFAULT_GATEWAY_PORT_EXAMPLE = 18789;

function formatInlineCliCommand(command: string): string {
  return `\`${formatCliCommand(command)}\``;
}

/** Explain the valid TCP port range with a concrete example. */
export function formatPortRangeHint(example = DEFAULT_GATEWAY_PORT_EXAMPLE): string {
  return `Use a port number from 1 to 65535, for example ${example}.`;
}

/** Format an invalid CLI port option using the shared port-range hint. */
export function formatInvalidPortOption(
  option: string,
  example = DEFAULT_GATEWAY_PORT_EXAMPLE,
): string {
  return `Invalid ${option}. ${formatPortRangeHint(example)}`;
}

/** Explain a bad configured port and include the equivalent CLI override. */
export function formatInvalidConfigPort(
  path: string,
  example = DEFAULT_GATEWAY_PORT_EXAMPLE,
): string {
  return `Invalid ${path} in config. Set ${path} to a number from 1 to 65535, or pass --port ${example}.`;
}

/** Format the standard missing-channel error plus channel-list recovery command. */
export function formatUnknownChannelMessage(params: {
  channel: string;
  listCommand?: string;
  purpose?: string;
}): string {
  const purpose = params.purpose ? ` for ${params.purpose}` : "";
  const listCommand = params.listCommand ?? "openclaw channels list --all";
  return `Unknown channel "${params.channel}"${purpose}. Run ${formatInlineCliCommand(
    listCommand,
  )} to see configured and installable channels.`;
}

/** Format a channel capability miss with the inspection command for that channel. */
export function formatUnsupportedChannelActionMessage(params: {
  channel: string;
  action: string;
  inspectCommand?: string;
}): string {
  const inspectCommand =
    params.inspectCommand ?? `openclaw channels capabilities --channel ${params.channel}`;
  return `Channel "${params.channel}" does not support ${params.action}. Run ${formatInlineCliCommand(
    inspectCommand,
  )} to inspect supported actions.`;
}

/** Detect a structured value whose inner quotes were likely removed by the shell. */
function looksShellStrippedJson(value: string): boolean {
  const trimmed = value.trim();
  const balanced =
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("{") && trimmed.endsWith("}"));
  if (!balanced) {
    return false;
  }
  // Valid JSON strings always carry double quotes; a bare, complete array or
  // object without any double-quote character reaching the parser is the
  // classic Windows PowerShell single-quoted-argument handoff failure.
  // Single quotes are content (e.g. ["O'Brien"]), not evidence of surviving
  // JSON quoting. Incomplete values (e.g. "{bad") are ordinary JSON typos.
  return !trimmed.includes('"');
}

/** Format strict JSON parsing failures without exposing long untrusted input verbatim. */
export function formatStrictJsonParseFailure(params: { value: string; cause: unknown }): string {
  const rawCause = params.cause instanceof Error ? params.cause.message : String(params.cause);
  const cause = rawCause.trim().replace(/[.。]+$/u, "");
  const preview =
    params.value.length > 48 ? `${truncateUtf16Safe(params.value, 45).trimEnd()}...` : params.value;
  const parts = [
    `Could not parse ${JSON.stringify(preview)} as JSON for --strict-json.`,
    `${cause}.`,
    `Use valid JSON, for example ${formatInlineCliCommand(
      "openclaw config set gateway.port 18789 --strict-json",
    )}.`,
    "For plain strings, omit --strict-json.",
  ];
  if (looksShellStrippedJson(params.value)) {
    parts.push(
      `The value looks like a JSON array or object without string quotes; Windows PowerShell often removes inner quotes before OpenClaw receives the argument. Put structured values in a JSON5 patch file and apply it with ${formatInlineCliCommand(
        "openclaw config patch --file ./openclaw.patch.json5",
      )}.`,
    );
  }
  return parts.join(" ");
}

/** Normalize gateway failure text and attach the deep-status recovery command. */
export function formatGatewayCommandFailure(params: {
  action: string;
  error: unknown;
  inspectCommand?: string;
}): string {
  const raw = params.error instanceof Error ? params.error.message : String(params.error);
  const message = raw
    .replace(/\s*Run [`"]?openclaw doctor[`"]? for diagnostics\.?/gi, "")
    .replace(/\s+Gateway target:\s+.*$/isu, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.。]+$/u, "");
  const inspectCommand = params.inspectCommand ?? "openclaw gateway status --deep";
  const detail = message ? `: ${message}` : "";
  return `Could not ${params.action} because the Gateway did not respond${detail}. Run ${formatInlineCliCommand(
    inspectCommand,
  )} to inspect the active Gateway.`;
}

/** Format a generic lookup miss with the list command that can recover it. */
export function formatLookupMiss(params: {
  noun: string;
  value: string;
  listCommand: string;
  valueLabel?: string;
}): string {
  const valueLabel = params.valueLabel ?? params.noun.toLowerCase();
  return `${params.noun} not found: ${params.value}. Run ${formatInlineCliCommand(
    params.listCommand,
  )} to see recent ${valueLabel}s.`;
}

/** Format a plugin lookup miss with optional ClawHub search guidance. */
export function formatMissingPluginMessage(params: {
  id: string;
  listCommand?: string;
  includeSearch?: boolean;
}): string {
  const listCommand = params.listCommand ?? "openclaw plugins list";
  const searchHint = params.includeSearch
    ? `, or ${formatInlineCliCommand("openclaw plugins search " + params.id)} to look for installable plugins`
    : "";
  return `Plugin not found: ${params.id}. Run ${formatInlineCliCommand(
    listCommand,
  )} to see installed plugins${searchHint}.`;
}
