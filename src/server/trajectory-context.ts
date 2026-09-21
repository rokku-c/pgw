import { hash } from "./security";
import { atomic } from "./transactions";
import type { ClientKey, Traffic } from "../shared/types";

export interface CallContext {
  sessionKey: string;
  ownerKey: string;
  agent: string | null;
  nativeSessionId: string | null;
  nativeTurnId: string | null;
  stepId: string | null;
  runId: string | null;
  turnNumber: number | null;
  evidence: string;
  project: string | null;
  runtime: { controls: unknown; timeoutSeconds: number; elapsedMs: number; observedAt: number } | null;
}
const header = (request: Request, name: string) => {
  const value = request.headers.get(name)?.trim();
  return value && value.length <= 300 && !/[\x00-\x1f]/.test(value) ? value : null;
};
export async function callContext(request: Request, client: ClientKey, group: string, affinityId: string | null): Promise<CallContext> {
  const ownerKey = client.runId ? `run:${client.runId}` : `client:${client.id}`;
  const run = client.runId ? await atomic(database => database.query("SELECT agent,nativeSessionId,nativeTurnId,turnCount,workspace,controls,timeoutSeconds,elapsedMs FROM runs WHERE id=?").get(client.runId!) as { agent: string; nativeSessionId: string | null; nativeTurnId: string | null; turnCount: number; workspace: string; controls: string; timeoutSeconds: number; elapsedMs: number } | null) : null;
  const definition = [["x-claude-code-session-id", "claude"], ["x-codex-session-id", "codex"], ["x-pgw-session", null], ["x-session-id", null]] as const;
  const observed = definition.map(([name, agent]) => ({ name, agent, value: header(request, name) })).find(item => item.value);
  const nativeSessionId = run?.nativeSessionId || observed?.value || null;
  const agent = run?.agent || observed?.agent || null;
  const sessionKey = client.runId ? `managed:${client.runId}` : observed ? `external:${hash(JSON.stringify([ownerKey, agent, observed.name, observed.value, client.project]))}` : affinityId ? `route:${affinityId}` : `call:${group}`;
  return {
    sessionKey, ownerKey, agent, nativeSessionId, runId: client.runId,
    nativeTurnId: run?.nativeTurnId || header(request, "x-pgw-turn-id") || header(request, "x-codex-turn-id"),
    stepId: header(request, "x-pgw-step-id"), turnNumber: run?.turnCount || null,
    evidence: run ? "managed_run" : observed?.name || (affinityId ? "route_affinity" : "request_group"),
    project: run?.workspace || client.project,
    runtime: run ? {controls:JSON.parse(run.controls),timeoutSeconds:run.timeoutSeconds,elapsedMs:run.elapsedMs,observedAt:Date.now()} : null,
  };
}
export async function recordCallContext(traffic: Traffic, context: CallContext) {
  await atomic(database => database.query("INSERT OR IGNORE INTO trajectory_call_context(requestId,sessionKey,ownerKey,agent,nativeSessionId,nativeTurnId,stepId,runId,turnNumber,evidence,project,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(traffic.id, context.sessionKey, context.ownerKey, context.agent, context.nativeSessionId, context.nativeTurnId, context.stepId, context.runId, context.turnNumber, context.evidence, context.project, traffic.createdAt));
}
