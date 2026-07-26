/**
 * Cron outcome reporting tool.
 *
 * Cron-triggered embedded agent runs use this tool to explicitly declare their
 * terminal outcome as a structured signal, replacing the previous
 * text-sentinel (===DONE_ERR===) convention. The runner intercepts the call and
 * produces an EmbeddedRunFailureSignal so the cron scheduler can correctly
 * classify the run as failed and trigger failureAlert.
 *
 * The tool always succeeds at the tool-execution level — it has no external
 * side effects. Its sole purpose is to carry the structured outcome signal
 * from the agent to the runner via the tool call metadata.
 */

import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import type { AnyAgentTool } from "../tools/common.js";
import { textResult } from "../tools/common.js";

/** Tool name constant used for interception in the subscribe handlers. */
export const CRON_REPORT_OUTCOME_TOOL_NAME = "cron_report_outcome";

/** Structured outcome an agent can declare for a cron-triggered run. */
type CronOutcomeDeclaredStatus = "failed" | "completed";

export type CronOutcomeReport = {
  status: CronOutcomeDeclaredStatus;
  reason?: string;
};

const CronOutcomeReportToolSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("failed"), Type.Literal("completed")]),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Normalizes raw tool args into a CronOutcomeReport, or undefined on invalid input. */
export function normalizeCronOutcomeReport(args: unknown): CronOutcomeReport | undefined {
  if (!isRecord(args)) {
    return undefined;
  }
  const status = args.status;
  if (status !== "failed" && status !== "completed") {
    return undefined;
  }
  const reason = typeof args.reason === "string" ? args.reason : undefined;
  return { status, reason };
}

/** Creates the cron outcome reporting tool. */
export function createCronOutcomeReportTool(): AnyAgentTool {
  return {
    label: "Cron outcome",
    name: CRON_REPORT_OUTCOME_TOOL_NAME,
    displaySummary: "Report cron task outcome.",
    description:
      "Report the final outcome of this cron-triggered task. " +
      "Call with status='failed' when the task could not complete successfully; " +
      "the runner will record the run as errored and trigger the configured failure alert. " +
      "Call with status='completed' when the task finished normally.",
    parameters: CronOutcomeReportToolSchema,
    execute: async (_toolCallId, args) => {
      const report = normalizeCronOutcomeReport(args);
      if (!report) {
        return textResult(
          JSON.stringify({
            status: "error",
            message: "Invalid outcome report. Provide status: 'failed' | 'completed'.",
          }),
          null,
        );
      }
      return textResult(
        JSON.stringify({
          status: "recorded",
          outcome: report.status,
          ...(report.reason ? { reason: report.reason } : {}),
        }),
        report,
      );
    },
  };
}
