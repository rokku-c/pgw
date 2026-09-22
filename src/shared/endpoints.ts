import type { Protocol, WireProtocol } from "./types";
/** 某个目标实际会用哪条上游线路：目标显式声明优先，否则由服务商协议与入站协议推导。 */
export function upstreamWireOf(inbound: WireProtocol, targetProtocol: WireProtocol | undefined, providerProtocol: Protocol): WireProtocol {
  return targetProtocol || (providerProtocol === "anthropic" ? "messages" : providerProtocol === "gemini" ? "gemini" : providerProtocol === "typesafe" ? "systemone" : inbound === "responses" ? "responses" : "chat");
}
export function protocolBase(origin: string, protocol: WireProtocol) {
  return `${origin}${protocol === "messages" ? "/providers/anthropic" : protocol === "gemini" ? "/providers/google" : protocol === "systemone" ? "/providers/typesafe" : "/providers/openai/v1"}`;
}
export function protocolPath(protocol: WireProtocol, model: string, stream = false) {
  return protocol === "messages" ? "/v1/messages" : protocol === "responses" ? "/responses" : protocol === "chat" ? "/chat/completions" : protocol === "systemone" ? "/v1/systemone" : `/v1beta/models/${encodeURIComponent(model)}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
}
