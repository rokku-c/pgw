import type { WireProtocol } from "../shared/types";
import { ApiError } from "./security";

export interface Usage {
  inputTokens: number | null; outputTokens: number | null;
  cacheReadTokens: number; cacheWriteTokens: number; cacheWriteLongTokens: number; reasoningTokens: number;
}
export const emptyUsage = (): Usage => ({ inputTokens: null, outputTokens: null, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWriteLongTokens: 0, reasoningTokens: 0 });
function count(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ApiError(502, "invalid_upstream_usage");
  return value;
}
export function mergeUsage(previous: Usage, body: any, protocol: WireProtocol): Usage {
  const usage = body?.usage ?? body?.message?.usage ?? body?.response?.usage ?? body?.usageMetadata;
  if (!usage || typeof usage !== "object") return previous;
  const result = { ...previous };
  const read = count(usage.cache_read_input_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.cachedContentTokenCount);
  const write = count(usage.cache_creation_input_tokens);
  const long = count(usage.cache_creation?.ephemeral_1h_input_tokens);
  const reasoning = count(usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens ?? usage.thoughtsTokenCount);
  if (read !== null) result.cacheReadTokens = read;
  if (write !== null) result.cacheWriteTokens = write;
  if (long !== null) result.cacheWriteLongTokens = long;
  if (reasoning !== null) result.reasoningTokens = reasoning;
  const input = count(usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokenCount);
  const output = count(usage.output_tokens ?? usage.completion_tokens ?? usage.candidatesTokenCount);
  if (input !== null) result.inputTokens = protocol === "messages" ? input + result.cacheReadTokens + result.cacheWriteTokens : input;
  else if (protocol === "messages" && previous.inputTokens !== null) result.inputTokens = previous.inputTokens - previous.cacheReadTokens - previous.cacheWriteTokens + result.cacheReadTokens + result.cacheWriteTokens;
  if (output !== null) result.outputTokens = protocol === "gemini" ? output + result.reasoningTokens : output;
  else if (protocol === "gemini" && previous.outputTokens !== null) result.outputTokens = previous.outputTokens - previous.reasoningTokens + result.reasoningTokens;
  if ([result.inputTokens,result.outputTokens].some(value=>value!==null&&(!Number.isSafeInteger(value)||value<0))) throw new ApiError(502,"invalid_upstream_usage");
  if (result.cacheWriteLongTokens > result.cacheWriteTokens || result.inputTokens !== null && result.cacheReadTokens + result.cacheWriteTokens > result.inputTokens || result.outputTokens !== null && result.reasoningTokens > result.outputTokens) throw new ApiError(502, "invalid_upstream_usage");
  return result;
}
export interface PriceSnapshot { input: number | null; output: number | null; cacheRead?: number | null; cacheWrite?: number | null; cacheWriteLong?: number | null }
function price(value: number) {
  if (!Number.isFinite(value) || value < 0 || value > 100000 || Number(value.toFixed(6)) !== value) throw new ApiError(400, "invalid_price");
  return BigInt(value.toFixed(6).replace(".", ""));
}
export function usageCost(usage: Usage, rates: PriceSnapshot): number | null {
  if (usage.inputTokens === null || usage.outputTokens === null || rates.input === null || rates.output === null) return null;
  const parts: [number, number | null | undefined][] = [
    [usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens, rates.input], [usage.outputTokens, rates.output],
    [usage.cacheReadTokens, rates.cacheRead], [usage.cacheWriteTokens - usage.cacheWriteLongTokens, rates.cacheWrite], [usage.cacheWriteLongTokens, rates.cacheWriteLong],
  ];
  let result = 0n;
  for (const [tokens, rate] of parts) {
    if (!tokens) continue;
    if (rate === null || rate === undefined) return null;
    if (!Number.isSafeInteger(tokens) || tokens < 0) throw new ApiError(502, "invalid_upstream_usage");
    result += BigInt(tokens) * price(rate);
  }
  const micros = (result + 999999n) / 1000000n;
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) throw new ApiError(502, "usage_overflow");
  return Number(micros);
}
