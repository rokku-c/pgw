import type { CoordinatorMode } from "../shared/types";

export interface ContinuationInput {
  mode: CoordinatorMode;
  turnStatus: "completed" | "failed" | "interrupted" | "blocked";
  hasToolActivity: boolean;
  completionComplete: boolean;
  approvalsPending: boolean;
  userStopped: boolean;
}

export type ContinuationDecision =
  | { decision: "stop"; reason: string }
  | { decision: "suggest"; reason: string }
  | { decision: "continue"; reason: string; message: string };

export function decideContinuation(
  input: ContinuationInput,
): ContinuationDecision {
  if (input.mode === "off")
    return { decision: "stop", reason: "coordinator_disabled" };
  if (input.userStopped) return { decision: "stop", reason: "user_stopped" };
  if (input.approvalsPending)
    return { decision: "stop", reason: "approval_pending" };
  if (input.turnStatus !== "completed")
    return { decision: "stop", reason: `turn_${input.turnStatus}` };
  if (input.completionComplete)
    return { decision: "stop", reason: "criteria_satisfied" };
  if (!input.hasToolActivity)
    return { decision: "stop", reason: "no_tool_activity" };
  if (input.mode === "suggest")
    return { decision: "suggest", reason: "tool_result_needs_review" };
  return {
    decision: "continue",
    reason: "tool_result_needs_model_continuation",
    message:
      "[Gateway Coordinator] 最近的工具调用已返回，但目标尚未确认完成。请先检查工具结果和当前状态；如果仍有安全且必要的下一步，请继续执行，否则明确说明阻塞或完成依据。不要重复已经完成的副作用操作。",
  };
}

if (import.meta.main) {
  const base = {
    turnStatus: "completed" as const,
    hasToolActivity: true,
    completionComplete: false,
    approvalsPending: false,
    userStopped: false,
  };
  console.assert(
    decideContinuation({ ...base, mode: "continue" }).decision === "continue",
  );
  console.assert(
    decideContinuation({ ...base, mode: "suggest" }).decision === "suggest",
  );
  console.assert(
    decideContinuation({ ...base, mode: "off" }).reason ===
      "coordinator_disabled",
  );
  console.assert(
    decideContinuation({ ...base, mode: "continue", hasToolActivity: false })
      .reason === "no_tool_activity",
  );
  console.assert(
    decideContinuation({ ...base, mode: "continue", approvalsPending: true })
      .reason === "approval_pending",
  );
  console.assert(
    decideContinuation({ ...base, mode: "continue", userStopped: true })
      .reason === "user_stopped",
  );
  console.assert(
    decideContinuation({ ...base, mode: "continue", completionComplete: true })
      .reason === "criteria_satisfied",
  );
}
