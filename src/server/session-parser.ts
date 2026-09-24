import { createHash } from "node:crypto";
import type { SessionEvent } from "../shared/types";

export const parserVersion = 1;
export function redact(text: string) {
  return text
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|pgw_[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g,
      "[redacted]",
    )
    .replace(
      /((?:api[_-]?key|authorization|password|secret|access_token)["']?\s*[:=]\s*["']?)([^\s"',}]{8,})/gi,
      "$1[redacted]",
    );
}
function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function content(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((p) =>
      p &&
      ["text", "input_text", "output_text"].includes(p.type) &&
      typeof p.text === "string"
        ? [p.text]
        : p?.type === "tool_result"
          ? [content(p.content)]
          : [],
    )
    .join("\n");
}
export interface ParsedEvent {
  event: Pick<
    SessionEvent,
    | "kind"
    | "role"
    | "origin"
    | "text"
    | "metadata"
    | "nativeId"
    | "parentId"
    | "timestamp"
    | "sourceKey"
  >;
  session: {
    agent?: string;
    nativeId?: string;
    project?: string;
    model?: string;
    title?: string;
    parentSessionId?: string;
  };
}
export function parseSessionLine(
  line: string,
  agent: string,
  offset: number,
): ParsedEvent {
  const value = JSON.parse(line);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_event");
  const p = value.payload ?? {};
  const event: ParsedEvent["event"] = {
    kind: "unknown",
    role: "unknown",
    origin: "unknown",
    text: null,
    metadata: {},
    nativeId: string(value.uuid ?? value.id),
    parentId: string(value.parentUuid ?? value.parentId),
    timestamp: null,
    sourceKey: "",
  };
  const session: ParsedEvent["session"] = {};
  const time = value.timestamp ?? value.time;
  const parsedTime =
    typeof time === "number"
      ? time < 100000000000
        ? time * 1000
        : time
      : typeof time === "string"
        ? Date.parse(time)
        : NaN;
  if (
    Number.isFinite(parsedTime) &&
    parsedTime > 0 &&
    parsedTime < 8640000000000000
  )
    event.timestamp = parsedTime;
  if (value.type === "session_meta") {
    session.agent = "codex";
    session.nativeId = string(p.id) || undefined;
    session.project = string(p.cwd) || undefined;
    session.parentSessionId =
      string(p.forked_from_id ?? p.parent_thread_id) || undefined;
    event.kind = "metadata";
  } else if (value.type === "session" && value.id) {
    session.agent = "pi";
    session.nativeId = string(value.id) || undefined;
    session.project = string(value.cwd) || undefined;
    session.parentSessionId = string(value.parentSession) || undefined;
    event.kind = "metadata";
    event.nativeId = null;
  } else if (value.sessionId) {
    session.agent = "claude";
    session.nativeId = string(value.sessionId) || undefined;
    session.project = string(value.cwd) || undefined;
  }
  if (value.cwd) session.project = string(value.cwd) || undefined;
  if (value.type === "turn_context") {
    session.model = string(p.model) || undefined;
    session.project = string(p.cwd) || session.project;
    event.kind = "metadata";
  }
  if (value.type === "model_change") {
    session.model = string(value.modelId) || undefined;
    event.kind = "metadata";
  }
  const message = value.message ?? (value.type === "response_item" ? p : null);
  if (message && typeof message === "object") {
    const role =
      message.role ||
      (value.type === "user" || value.type === "assistant"
        ? value.type
        : undefined);
    if (
      [
        "user",
        "assistant",
        "system",
        "developer",
        "tool",
        "toolResult",
      ].includes(role)
    ) {
      event.role =
        role === "developer" ? "system" : role === "toolResult" ? "tool" : role;
      event.origin = event.role;
      event.kind = event.role === "tool" ? "tool_result" : "message";
      event.text = content(message.content) || null;
      session.model = string(message.model) || session.model;
      const blocks = Array.isArray(message.content) ? message.content : [];
      const calls = blocks.filter(
        (b: any) => b && ["tool_use", "toolCall"].includes(b.type),
      );
      const results = blocks.filter((b: any) => b?.type === "tool_result");
      if (calls.length) {
        event.kind = "tool_call";
        event.metadata.tools = calls.map((b: any) => ({
          name: b.name,
          id: b.id,
        }));
      }
      if (results.length) {
        event.kind = "tool_result";
        event.role = "tool";
        event.origin = "tool";
        event.metadata.callIds = results.map((b: any) => b.tool_use_id);
      }
      if (role === "toolResult") {
        event.metadata.callId = message.toolCallId;
        event.metadata.toolName = message.toolName;
        event.metadata.isError = message.isError === true;
      }
      if (
        value.isMeta ||
        (event.role === "user" &&
          event.text &&
          /^\s*(?:<|#\s|\[tool)/i.test(event.text))
      )
        event.origin = "unknown";
    }
    if (["function_call", "custom_tool_call"].includes(message.type)) {
      event.kind = "tool_call";
      event.role = "assistant";
      event.origin = "assistant";
      event.metadata = { name: message.name, callId: message.call_id };
      event.text = string(message.arguments ?? message.input);
    }
    if (
      ["function_call_output", "custom_tool_call_output"].includes(message.type)
    ) {
      event.kind = "tool_result";
      event.role = "tool";
      event.origin = "tool";
      event.metadata.callId = message.call_id;
      event.text = content(message.output) || null;
    }
  }
  if (value.type === "event_msg") {
    event.kind = "metadata";
    event.metadata.nativeType = p.type;
    if (["task_started", "task_complete", "turn_aborted"].includes(p.type))
      event.metadata.turnId = p.turn_id;
    if (p.type === "token_count")
      event.metadata.usage = p.info?.total_token_usage;
  }
  if (
    ["compaction", "compact_boundary", "compacted"].includes(value.type) ||
    value.subtype === "compact_boundary"
  ) {
    event.kind = "compaction";
    event.role = "system";
    event.origin = "system";
    event.text = string(value.summary ?? p.message) || null;
    event.metadata.firstKeptEntryId = value.firstKeptEntryId;
  }
  if (["branch_summary", "leaf", "label"].includes(value.type)) {
    event.kind = "branch";
    event.role = "system";
    event.origin = "system";
    event.text = string(value.summary ?? value.label);
  }
  if (value.type === "summary") {
    event.kind = "metadata";
    session.title = string(value.summary)?.slice(0, 160);
  }
  if (event.kind === "unknown")
    event.metadata.nativeType = string(value.type) || "unknown";
  if (event.text !== null) {
    event.text = redact(event.text);
    if (event.text.length > 262144) {
      event.text = event.text.slice(0, 262144);
      event.metadata.truncated = true;
    }
  }
  if (event.kind === "message" && event.origin === "user" && event.text)
    session.title = event.text.replace(/\s+/g, " ").slice(0, 160);
  if (event.nativeId)
    event.sourceKey = createHash("sha256")
      .update(`${event.nativeId}:${line}`)
      .digest("hex");
  else event.sourceKey = String(offset);
  return { event, session };
}
