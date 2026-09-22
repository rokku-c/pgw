import type { ModelAlias, ModelRoute, WireProtocol } from "./types";

/** 客户端别名里表示兜底的保留名：未命中任何路由别名与具名别名的请求名都用它指向的路由。 */
export const MODEL_ALIAS_ANY = "*";

/**
 * 把请求里的模型名解析到一条**允许的**路由。顺序：路由别名精确匹配（原有语义），
 * 再查客户端别名（先具名精确、后 `*` 兜底）。别名目标必须落在 `routes` 内，
 * 因此授权边界仍由 `client.routeIds` 决定，别名不会越权。
 */
export function resolveRoute(routes: ModelRoute[], model: string, aliases: ModelAlias[] = []): ModelRoute | undefined {
  const direct = routes.find(route => route.alias === model);
  if (direct) return direct;
  const alias = aliases.find(item => item.name !== MODEL_ALIAS_ANY && item.name === model)
    ?? aliases.find(item => item.name === MODEL_ALIAS_ANY);
  return alias ? routes.find(route => route.id === alias.routeId) : undefined;
}

export type RoutePick = { route: ModelRoute; fallback: boolean };

/**
 * 为 agent 选一条路由。优先协议精确匹配；找不到时回退到任一非 gemini 路由——
 * 路由的 `protocol` 只是面向哪个入口设计的标签，真正是否需要转换由网关按目标与入站协议决定
 * （见 `upstreamWireOf`），所以标签不同不代表不可用。
 *
 * `preferred` 传 null 表示该 agent 自身按路由标签决定线路（pi），直接取首个非 gemini 路由。
 * 精确匹配时返回的元素与 `routes.find(r => r.enabled && r.protocol === preferred && …)` 相同（filter 保序）。
 */
export function pickRoute(routes: ModelRoute[], preferred: WireProtocol | null, alias?: string): RoutePick | undefined {
  const enabled = routes.filter(route => route.enabled && (!alias || route.alias === alias));
  if (preferred === null) { const route = enabled.find(item => !["gemini", "systemone"].includes(item.protocol)); return route ? { route, fallback: false } : undefined; }
  const exact = enabled.find(route => route.protocol === preferred);
  if (exact) return { route: exact, fallback: false };
  const relaxed = enabled.find(route => !["gemini", "systemone"].includes(route.protocol));
  return relaxed ? { route: relaxed, fallback: true } : undefined;
}
