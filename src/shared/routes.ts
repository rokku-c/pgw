import type { ModelRoute, WireProtocol } from "./types";

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
  if (preferred === null) { const route = enabled.find(item => item.protocol !== "gemini"); return route ? { route, fallback: false } : undefined; }
  const exact = enabled.find(route => route.protocol === preferred);
  if (exact) return { route: exact, fallback: false };
  const relaxed = enabled.find(route => route.protocol !== "gemini");
  return relaxed ? { route: relaxed, fallback: true } : undefined;
}
