type ToolExecutionSettledEvent = {
  type: "tool.execution.completed";
};

export const TOOL_EXECUTION_SETTLED_METADATA_KEY = "toolExecutionSettled";

type ToolExecutionSettledMetadata = Readonly<{
  [TOOL_EXECUTION_SETTLED_METADATA_KEY]?: boolean;
}>;

const toolExecutionSettledEvents = new WeakSet<object>();

// Exact object identity is the core-only authority; payload fields cannot forge it.
// Only the core execution boundary that validated a successful tool settlement
// may mark an event. Public and trusted plugin emitters cannot supply this fact.
export function markToolExecutionSettledDiagnosticEvent<T extends ToolExecutionSettledEvent>(
  event: T,
): T {
  toolExecutionSettledEvents.add(event);
  return event;
}

export function consumeToolExecutionSettledDiagnosticEvent(event: object): boolean {
  return toolExecutionSettledEvents.delete(event);
}

/** Returns whether the core execution boundary validated this tool settlement. */
export function isToolExecutionSettledDiagnosticMetadata(
  metadata: Readonly<{ trusted: boolean } & ToolExecutionSettledMetadata>,
): boolean {
  return metadata.trusted && metadata[TOOL_EXECUTION_SETTLED_METADATA_KEY] === true;
}
