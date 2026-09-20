import type { WireProtocol } from "./types";
export function protocolBase(origin: string, protocol: WireProtocol) {
  return `${origin}${protocol === "messages" ? "/providers/anthropic" : protocol === "gemini" ? "/providers/google" : "/providers/openai/v1"}`;
}
export function protocolPath(protocol: WireProtocol, model: string, stream = false) {
  return protocol === "messages" ? "/v1/messages" : protocol === "responses" ? "/responses" : protocol === "chat" ? "/chat/completions" : `/v1beta/models/${encodeURIComponent(model)}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
}
