import { Effect } from "effect";
import type { Provider } from "../shared/types";
import { decrypt } from "./security";
import { db, ProviderSchema } from "./store";

export function upstreamHeaders(provider: Provider) {
  const headers = new Headers({ "content-type": "application/json" });
  if (provider.secretCipher) {
    const key = decrypt(provider.secretCipher);
    if (provider.protocol === "anthropic") headers.set("x-api-key", key);
    else if (provider.protocol === "gemini") headers.set("x-goog-api-key", key);
    else headers.set("authorization", `Bearer ${key}`);
  }
  if (provider.protocol === "anthropic") headers.set("anthropic-version", "2023-06-01");
  return headers;
}
export function endpoint(provider: Provider, path: string) {
  const base = provider.baseUrl.replace(/\/$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  if (provider.protocol === "gemini") return `${base.endsWith("/v1beta") ? base : `${base}/v1beta`}${suffix}`;
  return `${base.endsWith("/v1") ? base : `${base}/v1`}${suffix}`;
}
export async function probeProvider(provider: Provider) {
  const start = performance.now();
  const task = Effect.tryPromise({
    try: async () => {
      const response = await fetch(endpoint(provider, "/models"), {
        headers: upstreamHeaders(provider), redirect: "error", signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
      const body = await response.json() as { data?: { id: string }[]; models?: { name: string }[] };
      return (body.data?.map(m => m.id) ?? body.models?.map(m => m.name.replace(/^models\//, "")) ?? []).slice(0, 300);
    },
    catch: error => error instanceof Error ? error : new Error("Connection failed"),
  });
  const result = await Effect.runPromise(Effect.either(task));
  const latencyMs = Math.round(performance.now() - start);
  const update = { health: result._tag === "Right" ? "up" as const : "down" as const, latencyMs,
    lastChecked: Date.now(), updatedAt: Date.now(), lastError: result._tag === "Left" ? result.left.message.slice(0, 160) : null };
  await db.getRepository(ProviderSchema).update(provider.id, update);
  return { ...update, models: result._tag === "Right" ? result.right : [] };
}
