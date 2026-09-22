import { realpath, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { db, RouteSchema, ClientSchema, RunSchema, RunEventSchema, ApprovalSchema, record, audit } from "./store";
import { ApiError, hash, newClientKey } from "./security";
import { budgetSummary } from "./budget";
import { validateGrants, revokeMcpAccess } from "./mcp";
import { createAdapter, type AgentAdapter, type NativeRequest } from "./agent-adapters";
import { decideContinuation } from "./coordinator";
import type { Run, RunStatus, RunControls, RunApproval } from "../shared/types";

export const defaultControls: RunControls = { mode: "turn", maxTurns: 1, maxNoProgress: 3, coordinatorMode: "off", budgetMicros: null, tokenLimit: null, permission: "read-only", completionFiles: [] };
const owner = crypto.randomUUID();
interface ActiveRun {
  run: Run; adapter?: AgentAdapter; stop?: { status: RunStatus; reason: string };
  task: Promise<void>; approvals: Map<string, { nativeId: string | number; answer: (result: Record<string, unknown>) => void }>;
}
const live = new Map<string, ActiveRun>();
let starting = 0;
async function getRun(id: string) {
  const run = await db.getRepository(RunSchema).findOneBy({ id });
  if (!run) throw new ApiError(404, "run_not_found");
  run.controls = { ...defaultControls, ...run.controls };
  return run;
}
async function event(run: Run, kind: string, detail: Record<string, unknown> = {}) {
  await db.getRepository(RunEventSchema).save({ ...record(), runId: run.id, turn: run.turnCount, kind, detail });
}
async function update(run: Run, changes: Partial<Run>) {
  Object.assign(run, changes, { updatedAt: Date.now() });
  await db.getRepository(RunSchema).update(run.id, { ...changes, updatedAt: run.updatedAt } as never);
}
async function completion(run: Run) {
  const evidence: { path: string; hash: string; matched: boolean }[] = [];
  for (const criterion of run.controls.completionFiles) {
    const candidate = await realpath(resolve(run.workspace, criterion.path)).catch(() => null);
    if (!candidate) { evidence.push({ path: criterion.path, hash: "", matched: false }); continue; }
    const inside = relative(run.workspace, candidate);
    if (inside.startsWith("..") || isAbsolute(inside)) throw new ApiError(403, "completion_path_outside_workspace");
    const file = Bun.file(candidate);
    if (!(await stat(candidate)).isFile() || file.size > 4 * 1024 * 1024) { evidence.push({ path: criterion.path, hash: "", matched: false }); continue; }
    const text = await file.text();
    evidence.push({ path: criterion.path, hash: hash(text), matched: !criterion.contains || text.includes(criterion.contains) });
  }
  return { complete: evidence.length > 0 && evidence.every(e => e.matched), evidence };
}
async function pendingApproval(control: ActiveRun, request: NativeRequest, answer: (value: Record<string, unknown>) => void) {
  const run = control.run;
  if (control.stop) { answer({ decision: "cancel" }); return; }
  let kind: RunApproval["kind"];
  if (request.method === "item/commandExecution/requestApproval") kind = "command";
  else if (request.method === "item/fileChange/requestApproval") kind = "file";
  else if (["item/tool/requestUserInput", "tool/requestUserInput", "pi/input"].includes(request.method)) kind = "input";
  else {
    await event(run, "approval.unsupported", { method: request.method });
    control.stop = { status: "blocked", reason: "unsupported_native_approval" };
    if (request.method === "item/permissions/requestApproval") answer({ permissions: {}, scope: "turn" });
    else answer({ decision: "cancel" });
    setTimeout(() => { void control.adapter?.interrupt().catch(() => control.adapter?.close()); }, 0);
    return;
  }
  const approval = await db.getRepository(ApprovalSchema).save({ ...record(), runId: run.id, requestId: String(request.id), kind,
    method: request.method, payload: request.params, status: "pending", response: null });
  control.approvals.set(approval.id, { nativeId: request.id, answer });
  await update(run, { status: kind === "input" ? "waiting_for_input" : "waiting_for_approval" });
  await event(run, "approval.requested", { approvalId: approval.id, kind });
}
async function execute(control: ActiveRun, message?: string) {
  const run = control.run;
  const began = Date.now();
  let clientId: string | undefined;
  let turnToolActivity = false;
  let outputDirty = false;
  let saving = Promise.resolve();
  const remaining = run.timeoutSeconds * 1000 - run.elapsedMs;
  const timeout = setTimeout(() => { control.stop = { status: "budget_exhausted", reason: "time_limit" }; void control.adapter?.interrupt().catch(() => control.adapter?.close()); }, Math.max(0, remaining));
  const heartbeat = setInterval(() => {
    saving = saving.then(async () => {
      await db.getRepository(RunSchema).update(run.id, { leaseExpiresAt: Date.now() + 30000, elapsedMs: run.elapsedMs + Date.now() - began, ...(outputDirty ? { output: run.output } : {}), updatedAt: Date.now() });
      outputDirty = false;
    }).catch(error => { control.stop = { status: "blocked", reason: "persistence_failure" }; console.error("Runtime persistence", error); void control.adapter?.interrupt(); });
  }, 3000);
  try {
    if (remaining <= 0) { control.stop = { status: "budget_exhausted", reason: "time_limit" }; return; }
    const route = await db.getRepository(RouteSchema).findOneBy({ id: run.routeId, enabled: true });
    if (!route) throw new ApiError(409, "route_unavailable");
    const key = newClientKey();
    const client = await db.getRepository(ClientSchema).save({ ...record(), name: `${run.agent}:${run.id.slice(0, 8)}`, kind: "temporary", keyHash: hash(key),
      keyPreview: `${key.slice(0, 8)}…${key.slice(-4)}`, enabled: true, project: run.workspace, personalize: true, routeIds: [route.id], lastUsedAt: null,
      mcpGrants: run.controls.mcpGrants || [], memoryAccess: run.controls.memoryAccess || false, budgetMicros: run.controls.budgetMicros, tokenLimit: run.controls.tokenLimit, maxConcurrent: 4, runId: run.id, expiresAt: Date.now() + remaining });
    clientId = client.id;
    await update(run, { clientId, status: "starting", stopReason: null, endedAt: null });
    await event(run, "run.started", { resumed: run.turnCount > 0, controls: run.controls });
    control.adapter = await createAdapter(run, route, key, {
      output: text => { run.output = (run.output + text).slice(-500000); outputDirty = true; },
      identity: async (session, turn = null) => { await update(run, { nativeSessionId: session, nativeTurnId: turn }); },
      event: async (kind, detail) => {
        if (kind === "native.item" || kind === "native.tool") {
          const type = String(detail.type || "").toLowerCase();
          if (/(tool|command|function|mcp|computer|file)/.test(type)) turnToolActivity = true;
        }
        if (kind === "native.request_resolved") {
          for (const [id, approval] of control.approvals) if (String(approval.nativeId) === String(detail.requestId)) {
            control.approvals.delete(id); await db.getRepository(ApprovalSchema).update(id, { status: "expired", updatedAt: Date.now() });
          }
          if (!control.approvals.size && !control.stop) await update(run, { status: "running" });
        }
        await event(run, kind, detail);
      },
      approval: (request, answer) => pendingApproval(control, request, answer),
    });
    let next = message || (run.turnCount ? `继续已授权的目标：${run.goal}\n先核对已完成工作及当前状态，避免重复副作用。` : run.goal);
    if (run.controls.mode === "goal" && run.controls.completionFiles.length) next += `\n用户设定的完成条件：${JSON.stringify(run.controls.completionFiles)}`;
    while (!control.stop) {
      if (run.turnCount >= run.controls.maxTurns) { control.stop = { status: "budget_exhausted", reason: "turn_limit" }; break; }
      const funds = await budgetSummary("run", run.id);
      if (run.controls.budgetMicros !== null && funds.costMicros + funds.heldMicros >= run.controls.budgetMicros) { control.stop = { status: "budget_exhausted", reason: "cost_limit" }; break; }
      if (run.controls.tokenLimit !== null && funds.tokens + funds.heldTokens >= run.controls.tokenLimit) { control.stop = { status: "budget_exhausted", reason: "token_limit" }; break; }
      turnToolActivity = false;
      await update(run, { turnCount: run.turnCount + 1, status: "running" });
      await event(run, "turn.started", { input: next });
      const result = await control.adapter.turn(next);
      await event(run, "turn.completed", { status: result.status, error: result.error ?? null });
      if (control.stop) break;
      if (control.approvals.size) { control.stop = { status: "blocked", reason: "approval_unresolved" }; break; }
      if (result.status !== "completed") {
        const reason = result.error || result.status;
        control.stop = { status: /budget|token_budget|price_required/.test(reason) ? "budget_exhausted" : result.status === "blocked" ? "blocked" : result.status === "interrupted" ? "paused" : "failed", reason };
        break;
      }
      await update(run, { status: "evaluating" });
      const proof = await completion(run);
      await event(run, "goal.evaluated", { mode: run.controls.mode, evidence: proof.evidence });
      if (run.controls.mode === "turn" || proof.complete) { control.stop = { status: "completed", reason: run.controls.mode === "turn" ? "turn_completed" : "criteria_satisfied" }; break; }
      if (!run.controls.completionFiles.length) {
        const decision = decideContinuation({ mode: run.controls.coordinatorMode, turnStatus: result.status, hasToolActivity: turnToolActivity, completionComplete: proof.complete, approvalsPending: control.approvals.size > 0, userStopped: !!control.stop });
        await event(run, "coordinator.decided", { ...decision, hasToolActivity: turnToolActivity });
        if (decision.decision === "continue") { next = decision.message; continue; }
        control.stop = { status: "waiting_for_input", reason: decision.reason === "tool_result_needs_review" ? "coordinator_suggested_continuation" : "completion_confirmation_required" };
        break;
      }
      const progress = hash(JSON.stringify(proof.evidence));
      const noProgressCount = progress === run.progressHash ? run.noProgressCount + 1 : 0;
      await update(run, { progressHash: progress, noProgressCount });
      if (noProgressCount >= run.controls.maxNoProgress) { control.stop = { status: "blocked", reason: "no_observed_progress" }; break; }
      next = `网关目标续跑，第 ${run.turnCount + 1} 轮。用户目标：${run.goal}\n尚未满足的完成条件：${JSON.stringify(run.controls.completionFiles.filter(c => proof.evidence.some(e => e.path === c.path && !e.matched)))}\n在原有权限内继续完成工作。遇到需要用户授权或无法推进的情况时明确说明，不重复已有副作用。`;
    }
  } catch (error) {
    if (!control.stop) control.stop = { status: "failed", reason: error instanceof ApiError ? error.code : error instanceof Error ? error.message.slice(0, 250) : "runtime_error" };
  } finally {
    clearTimeout(timeout); clearInterval(heartbeat);
    await control.adapter?.close().catch(error => console.error("Agent shutdown", error));
    await saving;
    if (clientId) { await db.getRepository(ClientSchema).update(clientId, { enabled: false, updatedAt: Date.now() }); await revokeMcpAccess({ clientId }); }
    await db.getRepository(ApprovalSchema).createQueryBuilder().update().set({ status: "expired", updatedAt: Date.now() }).where("runId = :id AND status = 'pending'", { id: run.id }).execute();
    const stop = control.stop || { status: "failed" as const, reason: "runtime_stopped" };
    await update(run, { output: run.output, status: stop.status, stopReason: stop.reason, elapsedMs: run.elapsedMs + Date.now() - began, endedAt: Date.now(), leaseOwner: null, leaseExpiresAt: null });
    await event(run, `run.${stop.status}`, { reason: stop.reason });
    await audit(`run.${stop.status}`, run.agent, { id: run.id, reason: stop.reason });
    live.delete(run.id);
  }
}
async function launch(run: Run, message?: string) {
  if (live.has(run.id)) throw new ApiError(409, "run_already_active");
  if (live.size + starting >= 3) throw new ApiError(429, "concurrency_limit");
  starting++;
  try {
    const lease = await db.getRepository(RunSchema).createQueryBuilder().update().set({ leaseOwner: owner, leaseExpiresAt: Date.now() + 30000, status: "starting", updatedAt: Date.now() })
      .where("id = :id AND (leaseOwner IS NULL OR leaseExpiresAt < :now)", { id: run.id, now: Date.now() }).execute();
    if (!lease.affected) throw new ApiError(409, "run_lease_held");
    run.leaseOwner = owner; run.leaseExpiresAt = Date.now() + 30000;
    const control: ActiveRun = { run, approvals: new Map(), task: Promise.resolve() };
    live.set(run.id, control);
    control.task = execute(control, message).catch(error => { console.error("Run persistence failure", error); live.delete(run.id); });
  } finally { starting--; }
  return await getRun(run.id);
}
export async function startRun(input: Pick<Run, "agent" | "goal" | "workspace" | "routeId" | "timeoutSeconds"> & { controls?: RunControls }) {
  if (!Bun.which(input.agent)) throw new ApiError(409, "agent_not_installed");
  const workspace = await realpath(input.workspace).catch(() => { throw new ApiError(400, "invalid_workspace"); });
  if (!(await stat(workspace)).isDirectory()) throw new ApiError(400, "invalid_workspace");
  const route = await db.getRepository(RouteSchema).findOneBy({ id: input.routeId, enabled: true });
  if (!route || (input.agent !== "pi" && route.protocol !== (input.agent === "codex" ? "responses" : "messages")) || (input.agent === "pi" && route.protocol === "gemini")) throw new ApiError(400, "protocol_mismatch");
  const controls = { ...defaultControls, ...input.controls };
  if (controls.mode === "turn") controls.maxTurns = 1;
  await validateGrants(controls.mcpGrants || []);
  if (input.agent === "pi" && (controls.memoryAccess || controls.mcpGrants?.length)) throw new ApiError(409, "pi_mcp_extension_required");
  if (live.size + starting >= 3) throw new ApiError(429, "concurrency_limit");
  if (input.agent === "pi" && controls.permission !== "read-only") throw new ApiError(409, "pi_workspace_sandbox_required");
  if (controls.budgetMicros !== null && (route.inputPrice === null || route.outputPrice === null)) throw new ApiError(409, "price_required");
  for (const file of controls.completionFiles) { const path = relative(workspace, resolve(workspace, file.path)); if (path.startsWith("..") || isAbsolute(path)) throw new ApiError(403, "completion_path_outside_workspace"); }
  const run = await db.getRepository(RunSchema).save({ ...record(), ...input, controls, workspace, status: "queued", output: "", exitCode: null, endedAt: null,
    turnCount: 0, nativeSessionId: null, nativeTurnId: null, clientId: null, elapsedMs: 0, stopReason: null, progressHash: null, noProgressCount: 0, leaseOwner: null, leaseExpiresAt: null });
  try { return await launch(run); }
  catch (error) {
    await update(run, { status: "blocked", stopReason: error instanceof ApiError ? error.code : "launch_failed", endedAt: Date.now() });
    throw error;
  }
}
export async function stopRun(id: string, paused = false) {
  const control = live.get(id);
  if (!control) {
    const run = await getRun(id);
    if (["completed", "cancelled", "failed"].includes(run.status)) throw new ApiError(409, "run_not_active");
    if (run.clientId) { await db.getRepository(ClientSchema).update(run.clientId, { enabled: false, updatedAt: Date.now() }); await revokeMcpAccess({ clientId: run.clientId }); }
    await update(run, { status: paused ? "paused" : "cancelled", stopReason: paused ? "user_paused" : "user_cancelled", endedAt: Date.now() });
    await event(run, `run.${run.status}`); return { ok: true };
  }
  control.stop = { status: paused ? "paused" : "cancelled", reason: paused ? "user_paused" : "user_cancelled" };
  if (control.run.clientId) { await db.getRepository(ClientSchema).update(control.run.clientId, { enabled: false }); await revokeMcpAccess({ clientId: control.run.clientId }); }
  await event(control.run, paused ? "pause.requested" : "stop.requested");
  void control.adapter?.interrupt().catch(() => control.adapter?.close());
  return { ok: true };
}
export async function resumeRun(id: string, input: { message?: string; extraTurns?: number; extraSeconds?: number; budgetMicros?: number; tokenLimit?: number }) {
  const run = await getRun(id);
  if (!["paused", "blocked", "waiting_for_input", "budget_exhausted", "failed"].includes(run.status)) throw new ApiError(409, "run_not_resumable");
  if (input.extraTurns) run.controls.maxTurns += input.extraTurns;
  if (input.extraSeconds) run.timeoutSeconds += input.extraSeconds;
  if (input.budgetMicros !== undefined) run.controls.budgetMicros = input.budgetMicros;
  if (input.tokenLimit !== undefined) run.controls.tokenLimit = input.tokenLimit;
  if (run.turnCount >= run.controls.maxTurns || run.elapsedMs >= run.timeoutSeconds * 1000) throw new ApiError(409, "extend_limits_required");
  const route = await db.getRepository(RouteSchema).findOneBy({ id: run.routeId, enabled: true });
  if (!route) throw new ApiError(409, "route_unavailable");
  await validateGrants(run.controls.mcpGrants || []);
  if (run.controls.budgetMicros !== null && (route.inputPrice === null || route.outputPrice === null)) throw new ApiError(409, "price_required");
  await update(run, { controls: run.controls, timeoutSeconds: run.timeoutSeconds, noProgressCount: 0 });
  await event(run, "resume.authorized", { input });
  return launch(run, input.message);
}
export async function steerRun(id: string, message: string) {
  const control = live.get(id);
  if (!control?.adapter || control.stop || control.run.status !== "running") throw new ApiError(409, "run_not_active");
  await control.adapter.steer(message); await event(control.run, "steer.authorized", { message });
  return { ok: true };
}
export async function completeRun(id: string) {
  const run = await getRun(id);
  if (live.has(id) || !["waiting_for_input", "paused", "blocked"].includes(run.status)) throw new ApiError(409, "run_not_reviewable");
  await update(run, { status: "completed", stopReason: "user_confirmed", endedAt: Date.now() });
  await event(run, "goal.confirmed", { source: "user" });
  return run;
}
export async function decideApproval(id: string, response: { accept?: boolean; answers?: Record<string, string[]>; value?: string }) {
  const approval = await db.getRepository(ApprovalSchema).findOneBy({ id, status: "pending" });
  if (!approval) throw new ApiError(409, "approval_not_pending");
  const control = live.get(approval.runId), pending = control?.approvals.get(id);
  if (!control || !pending || control.stop) throw new ApiError(409, "approval_expired");
  if (approval.kind !== "input" && typeof response.accept !== "boolean") throw new ApiError(400, "approval_decision_required");
  if (approval.kind === "input" && approval.method !== "pi/input" && response.accept !== false) {
    const questions = Array.isArray(approval.payload.questions) ? approval.payload.questions as { id: string }[] : [];
    if (questions.some(q => !response.answers?.[q.id]?.length || response.answers[q.id].some(a => !a.trim()))) throw new ApiError(400, "answers_required");
    if (Object.keys(response.answers || {}).some(id => !questions.some(q => q.id === id))) throw new ApiError(400, "unknown_question");
  }
  const value: Record<string, unknown> = approval.kind !== "input" ? { decision: response.accept === true ? "accept" : "cancel" } : approval.method === "pi/input" ? (response.accept === false ? { cancelled: true } : approval.payload.method === "confirm" ? { confirmed: response.accept === true } : response.value === undefined ? { cancelled: true } : { value: response.value }) : { answers: Object.fromEntries(Object.entries(response.answers || {}).map(([key, answers]) => [key, { answers }])) };
  await db.getRepository(ApprovalSchema).update(id, { status: response.accept === false ? "declined" : "accepted", response: value as never, updatedAt: Date.now() });
  if (response.accept === false) control.stop = { status: "blocked", reason: "approval_denied" };
  pending.answer(value); control.approvals.delete(id);
  if (!control.stop && !control.approvals.size) await update(control.run, { status: "running" });
  await event(control.run, "approval.decided", { approvalId: id, accepted: response.accept !== false });
  if (control.stop) void control.adapter?.interrupt();
  return { ok: true };
}
export async function stopOwnedRuns() {
  for (const control of live.values()) { control.stop = { status: "paused", reason: "gateway_shutdown" }; void control.adapter?.interrupt(); }
  await Promise.allSettled([...live.values()].map(item => item.task));
}
