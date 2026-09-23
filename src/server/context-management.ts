import { db } from "./store";
import { atomic } from "./transactions";
import type { AdaptiveContextPolicy, ModelRoute, Provider, RetryPolicy, Traffic, WireProtocol } from "../shared/types";

export const adaptiveDefaults: AdaptiveContextPolicy = { enabled: false, learn: true, compressionEnabled: false, compressionRatio: .8, maxTokens: null, awarenessPrompt: "部分较早上下文已由网关压缩。保留当前目标、约束和最近工具结果；不要假设被省略的细节仍然可见。" };
export const retryDefaults: RetryPolicy = { enabled: false, maxRetries: 3, backoffMs: 250, statuses: [408, 409, 425, 429, 500, 502, 503, 504] };
export async function adaptivePolicy() { return (await import("./store")).setting<AdaptiveContextPolicy>("adaptiveContext", adaptiveDefaults); }
export async function retryPolicy() { return (await import("./store")).setting<RetryPolicy>("transparentRetry", retryDefaults); }
export async function protocolConversionEnabled() { return (await import("./store")).setting<boolean>("protocolConversion", true); }
/** 互转时丢弃推理块而非拒绝。默认关闭，保持"无法保持的语义必须明确反馈"。 */
export async function discardReasoningEnabled() { return (await import("./store")).setting<boolean>("discardReasoning", false); }
/** 互转时忽略托管工具声明而非拒绝。默认关闭，与推理开关相互独立。 */
export async function ignoreHostedToolsEnabled() { return (await import("./store")).setting<boolean>("ignoreHostedTools", false); }
function estimate(value: unknown) { return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(value)) / 4)); }
function addPrompt(body: any, protocol: WireProtocol, prompt: string) {
  if (!prompt) return body;
  const next = structuredClone(body);
  if (protocol === "messages") next.system = typeof next.system === "string" ? `${next.system}\n\n${prompt}` : [...(next.system || []), { type: "text", text: prompt }];
  else if (protocol === "responses") next.instructions = typeof next.instructions === "string" ? `${next.instructions}\n\n${prompt}` : prompt;
  else if (protocol === "gemini") next.systemInstruction = { parts: [{ text: `${next.systemInstruction?.parts?.map((part: any) => part.text || "").join("\n") || ""}\n\n${prompt}`.trim() }] };
  else next.messages = [{ role: "system", content: prompt }, ...(next.messages || [])];
  return next;
}
function trimHistory(body: any, protocol: WireProtocol, budget: number) {
  const next = structuredClone(body);
  const key = protocol === "responses" ? "input" : protocol === "gemini" ? "contents" : "messages";
  if (!Array.isArray(next[key])) return { body: next, compressed: false, removed: 0 };
  const items = next[key], fixed = protocol === "gemini" ? items.filter((item: any) => item.role === "system") : items.filter((item: any) => ["system", "developer"].includes(item.role));
  let result = [...items], removed = 0;
  while (result.length > fixed.length + 1 && estimate({ ...next, [key]: result }) > budget) {
    const index = result.findIndex((item: any) => !fixed.includes(item) && !["tool", "tool_result", "function_call_output", "function_call"].includes(item.type || item.role));
    if (index < 0) break;
    result.splice(index, 1); removed++;
  }
  next[key] = result;
  return { body: next, compressed: removed > 0, removed };
}
export async function applyAdaptiveContext(body: any, protocol: WireProtocol, route: ModelRoute, provider: Provider, model: string) {
  if (protocol === "systemone") return { body, compressed: false, removed: 0, limit: route.contextLimit };
  const policy = await adaptivePolicy();
  if (!policy.enabled || !policy.compressionEnabled) return { body, compressed: false, removed: 0, limit: null as number | null, reason: "disabled" };
  const learned = await atomic(database => database.query("SELECT learnedLimit FROM adaptive_context_limits WHERE providerId=? AND model=? AND protocol=?").get(provider.id, model, protocol) as { learnedLimit: number | null } | null);
  const limit = Math.max(256, Math.min(policy.maxTokens || route.contextLimit, learned?.learnedLimit || policy.maxTokens || route.contextLimit));
  const budget = Math.max(128, Math.floor(limit * policy.compressionRatio));
  const result = trimHistory(body, protocol, budget);
  return { ...result, body: result.compressed ? addPrompt(result.body, protocol, policy.awarenessPrompt) : result.body, limit, reason: result.compressed ? "history_compressed" : "within_budget" };
}
function contextError(error: string | null, status: number | null) { return status === 400 && !!error && /context|token|length|window|max.*input/i.test(error); }
export async function recordAdaptiveObservation(traffic: Traffic, provider: Provider, model: string, protocol: WireProtocol, error: string | null) {
  const policy = await adaptivePolicy(); if (!policy.enabled || !policy.learn) return;
  const estimated = traffic.inputTokens ?? null, now = Date.now(), isContextError = contextError(error, traffic.upstreamStatus);
  await atomic(database => {
    const old = database.query("SELECT * FROM adaptive_context_limits WHERE providerId=? AND model=? AND protocol=?").get(provider.id, model, protocol) as any;
    const lower = Math.max(old?.lowerBound || 0, estimated || 0), upper = isContextError ? Math.min(old?.upperBound || Number.MAX_SAFE_INTEGER, Math.max(256, estimated || 256)) : old?.upperBound || null;
    const learnedLimit = upper ? Math.max(256, Math.floor(upper * .98)) : old?.learnedLimit || null;
    database.query("INSERT INTO adaptive_context_limits(providerId,model,protocol,learnedLimit,lowerBound,upperBound,observations,lastError,updatedAt) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(providerId,model,protocol) DO UPDATE SET learnedLimit=excluded.learnedLimit,lowerBound=excluded.lowerBound,upperBound=excluded.upperBound,observations=adaptive_context_limits.observations+1,lastError=excluded.lastError,updatedAt=excluded.updatedAt").run(provider.id,model,protocol,learnedLimit,lower,upper,(old?.observations||0)+1,isContextError?error:null,now);
  });
}
