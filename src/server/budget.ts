import { Database } from "bun:sqlite";
import { Effect, Schedule } from "effect";
import { join } from "node:path";
import { home } from "./config";
import { ApiError } from "./security";
import type { BudgetSummary, ClientKey, ModelRoute, Traffic } from "../shared/types";

import { atomic } from "./transactions";
export { closeLocalStore as closeBudgetStore } from "./transactions";

function scaledPrice(price: number): bigint {
  if (!Number.isFinite(price) || price < 0 || price > 100000) throw new ApiError(400, "invalid_price");
  if (Number(price.toFixed(6)) !== price) throw new ApiError(400, "price_precision");
  return BigInt(price.toFixed(6).replace(".", ""));
}
export function costMicros(input: number, output: number, inputPrice: number, outputPrice: number): number {
  if (![input, output].every(n => Number.isSafeInteger(n) && n >= 0)) throw new ApiError(502, "invalid_usage");
  const total = (BigInt(input) * scaledPrice(inputPrice) + BigInt(output) * scaledPrice(outputPrice) + 999999n) / 1000000n;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new ApiError(502, "usage_overflow");
  return Number(total);
}
function totals(db: Database, where: string, values: string[]): BudgetSummary {
  const row = db.query(`SELECT coalesce(sum(CASE WHEN status = 'held' THEN reservedMicros ELSE 0 END), 0) heldMicros,
    coalesce(sum(CASE WHEN status != 'held' THEN coalesce(costMicros,0) ELSE 0 END),0) costMicros,
    coalesce(sum(CASE WHEN status = 'held' THEN reservedTokens ELSE 0 END),0) heldTokens,
    coalesce(sum(CASE WHEN status != 'held' THEN coalesce(tokens,0) ELSE 0 END),0) tokens,
    count(*) requests, coalesce(sum(CASE WHEN status = 'held' THEN 1 ELSE 0 END),0) active,
    coalesce(sum(CASE WHEN status = 'uncertain' THEN 1 ELSE 0 END),0) uncertain
    FROM budget_reservations WHERE ${where}`).get(...values) as BudgetSummary;
  return row;
}
export async function budgetSummary(kind: "client" | "run", id: string) {
  return atomic(db => totals(db, `${kind === "run" ? "runId" : "clientId"} = ?`, [id]));
}
export function boundOutput(body: any, route: ModelRoute) {
  if (route.protocol === "systemone") {
    if (body.stream === true) throw new ApiError(400, "systemone_stream_unsupported");
    return route.outputLimit;
  }
  const field = route.protocol === "responses" ? "max_output_tokens" : route.protocol === "messages" ? "max_tokens" : route.protocol === "chat" ? (body.max_completion_tokens !== undefined ? "max_completion_tokens" : "max_tokens") : "maxOutputTokens";
  const source = route.protocol === "gemini" ? body.generationConfig || {} : body;
  const amount = source[field] ?? route.outputLimit;
  if (!Number.isSafeInteger(amount) || amount < 1) throw new ApiError(400, "invalid_output_limit");
  const outputTokens = Math.min(amount, route.outputLimit);
  if (route.protocol === "gemini") body.generationConfig = { ...source, [field]: outputTokens };
  else {
    body[field] = outputTokens;
    if (route.protocol === "chat" && field === "max_completion_tokens") delete body.max_tokens;
  }
  const choices = route.protocol === "gemini" ? body.generationConfig?.candidateCount ?? 1 : body.n ?? 1;
  if (!Number.isSafeInteger(choices) || choices < 1 || choices > 16) throw new ApiError(400, "invalid_candidate_count");
  return outputTokens * choices;
}
export async function reserveBudget(id: string, client: ClientKey, route: ModelRoute, outputTokens: number, target?: { key:string; maxConcurrent?:number }) {
  const priced = route.inputPrice !== null && route.outputPrice !== null;
  if (client.budgetMicros !== null && !priced) throw new ApiError(409, "price_required");
  const reservedTokens = route.contextLimit + outputTokens;
  const maxInputPrice = Math.max(route.inputPrice || 0, route.cacheReadPrice || 0, route.cacheWritePrice || 0, route.cacheWriteLongPrice || 0);
  const reservedMicros = priced ? costMicros(route.contextLimit, outputTokens, maxInputPrice, route.outputPrice!) : 0;
  return atomic(db => {
    if(target?.maxConcurrent){const used=db.query("SELECT count(*) n FROM budget_reservations WHERE targetKey=? AND status='held'").get(target.key) as {n:number};if(used.n>=target.maxConcurrent)throw new ApiError(429,"target_concurrency_limit");}
    const fresh = db.query("SELECT enabled, expiresAt, budgetMicros, tokenLimit, maxConcurrent FROM clients WHERE id = ?").get(client.id) as Pick<ClientKey, "enabled" | "expiresAt" | "budgetMicros" | "tokenLimit" | "maxConcurrent"> | null;
    if (!fresh?.enabled || fresh.expiresAt !== null && fresh.expiresAt <= Date.now()) throw new ApiError(401, "key_revoked");
    const totalsForKey = totals(db, "clientId = ?", [client.id]);
    const used = client.runId ? totals(db, "runId = ?", [client.runId]) : totalsForKey;
    if (totalsForKey.active >= fresh.maxConcurrent) throw new ApiError(429, "concurrency_limit");
    if (fresh.budgetMicros !== null && used.costMicros + used.heldMicros + reservedMicros > fresh.budgetMicros) throw new ApiError(402, "budget_exhausted");
    if (fresh.tokenLimit !== null && used.tokens + used.heldTokens + reservedTokens > fresh.tokenLimit) throw new ApiError(402, "token_budget_exhausted");
    if (client.runId) {
      const run = db.query("SELECT status FROM runs WHERE id = ?").get(client.runId) as { status: string } | null;
      if (!run || !["running", "starting", "evaluating"].includes(run.status)) throw new ApiError(409, "run_not_active");
    }
    const active = db.query("SELECT count(*) n FROM budget_reservations WHERE status = 'held'").get() as { n: number };
    if (active.n >= 32) throw new ApiError(429, "gateway_concurrency_limit");
    db.query("INSERT INTO budget_reservations (id,clientId,runId,project,createdAt,reservedMicros,reservedTokens,status,inputPrice,outputPrice,targetKey) VALUES (?,?,?,?,?,?,?,'held',?,?,?)").run(id, client.id, client.runId, client.project, Date.now(), reservedMicros, reservedTokens, route.inputPrice === null ? null : String(route.inputPrice), route.outputPrice === null ? null : String(route.outputPrice),target?.key||null);
    return { reservedMicros, reservedTokens };
  });
}
export async function settleBudget(id: string, traffic: Pick<Traffic, "inputTokens" | "outputTokens" | "costMicros">, definitiveRejection: boolean) {
  return atomic(db => {
    const held = db.query("SELECT reservedMicros,reservedTokens,status FROM budget_reservations WHERE id = ?").get(id) as { reservedMicros: number; reservedTokens: number; status: string } | null;
    if (!held || held.status !== "held") return;
    const known = traffic.inputTokens !== null && traffic.outputTokens !== null;
    const status = definitiveRejection ? "rejected" : known && traffic.costMicros !== null ? "settled" : "uncertain";
    const charge = definitiveRejection ? 0 : traffic.costMicros ?? held.reservedMicros;
    const tokens = definitiveRejection ? 0 : known ? traffic.inputTokens! + traffic.outputTokens! : held.reservedTokens;
    db.query("UPDATE budget_reservations SET status = ?, costMicros = ?, tokens = ? WHERE id = ? AND status = 'held'").run(status, charge, tokens, id);
  });
}
