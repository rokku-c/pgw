import { EventStreamParser } from "./event-stream";
import type { TrajectoryBlock, TrajectoryProjection, TrajectorySection, TrajectoryChange } from "../shared/trajectory";

const object = (value: any): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
export const trajectoryText = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "null";
export function displayBlock(block: TrajectoryBlock): string {
  const value: any = block.value;
  if (typeof value === "string") return value;
  if (!object(value)) return trajectoryText(value);
  if (block.kind === "tool_call") {
    const argumentsValue = value.function?.arguments ?? value.functionCall?.args ?? value.arguments ?? value.input;
    if (argumentsValue !== undefined) {
      if (typeof argumentsValue === "string") { try { return trajectoryText(JSON.parse(argumentsValue)); } catch { return argumentsValue; } }
      return trajectoryText(argumentsValue);
    }
  }
  if (block.kind === "tool_result") return trajectoryText(value.output ?? value.content ?? value.functionResponse?.response ?? value);
  if (block.kind === "reasoning") return trajectoryText(value.thinking ?? value.text ?? value.summary ?? value);
  if (block.kind === "message" || block.kind === "text") {
    const content = value.content ?? value.parts ?? value.text;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content.filter(part => object(part) && typeof part.text === "string" && part.thought !== true).map(part => part.text);
      if (text.length) return text.join("\n\n");
    }
  }
  return trajectoryText(value);
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function projectJson(value: any): TrajectoryBlock[] {
  const blocks: TrajectoryBlock[] = [];
  const add = (id: string, section: TrajectorySection, data: unknown, kind: TrajectoryBlock["kind"] = "value", role: string | null = null, name: string | null = null, callId: string | null = null) => {
    blocks.push({ id, section, kind, role, name, callId, value: data });
  };
  let body = value;
  if (object(value) && "body" in value && ("url" in value || "headers" in value)) {
    body = value.body;
    add("transport", "transport", Object.fromEntries(Object.entries(value).filter(([key]) => key !== "body")));
  }
  if (!object(body)) { add("body", "other", body); return blocks; }
  const seen = new Set<string>();
  for (const key of ["system", "instructions", "systemInstruction", "system_instruction"]) if (key in body) {
    add(key, "system", body[key], "message", "system", key); seen.add(key);
  }
  const message = (item: any, id: string, section: TrajectorySection) => {
    if (!object(item)) { add(id, section, item, "message", "user"); return; }
    const kind = ["function_call", "custom_tool_call", "tool_use", "toolCall"].includes(item.type) ? "tool_call"
      : ["function_call_output", "custom_tool_call_output", "tool_result", "toolResult"].includes(item.type) || ["tool", "toolResult"].includes(item.role) ? "tool_result"
      : ["reasoning", "thinking", "redacted_thinking"].includes(item.type) ? "reasoning" : "message";
    const role = typeof item.role === "string" ? item.role : kind === "tool_result" ? "tool" : section === "output" ? "assistant" : null;
    add(id, ["system", "developer"].includes(role || "") ? "system" : section, item, kind, role, item.name || null, item.call_id || item.tool_call_id || item.tool_use_id || item.toolCallId || (kind === "tool_call" ? item.id : null) || null);
    const parts = Array.isArray(item.content) ? item.content : Array.isArray(item.parts) ? item.parts : [];
    for (const [index, part] of parts.entries()) {
      if (!object(part)) continue;
      if (["tool_use", "toolCall", "tool_result"].includes(part.type) || part.functionCall || part.functionResponse) {
        const call = part.functionCall || part.functionResponse || part;
        add(`${id}/content/${index}`, section, part, part.type === "tool_result" || part.functionResponse ? "tool_result" : "tool_call", role, call.name || null, call.id || call.tool_use_id || null);
      } else if (["thinking", "reasoning", "redacted_thinking"].includes(part.type) || part.thought === true) {
        add(`${id}/content/${index}`, section, part, "reasoning", role);
      }
    }
    for (const [index, call] of (Array.isArray(item.tool_calls) ? item.tool_calls : []).entries()) add(`${id}/tool_calls/${index}`, section, call, "tool_call", role, call.function?.name || call.name || null, call.id || null);
  };
  for (const key of ["messages", "input", "contents", "output", "content"]) if (key in body) {
    seen.add(key);
    const section = ["output", "content"].includes(key) ? "output" : "messages";
    const items = Array.isArray(body[key]) ? body[key] : [body[key]];
    items.forEach((item: any, index: number) => message(item, `${key}/${index}`, section));
  }
  for (const key of ["choices", "candidates"]) if (Array.isArray(body[key])) {
    seen.add(key);
    body[key].forEach((choice: any, index: number) => {
      message(choice.message || choice.content || choice, `${key}/${index}`, "output");
      const rest = Object.fromEntries(Object.entries(choice).filter(([name]) => !["message", "content"].includes(name)));
      if (Object.keys(rest).length) add(`${key}/${index}/metadata`, "config", rest);
    });
  }
  if ("tools" in body) {
    seen.add("tools");
    (Array.isArray(body.tools) ? body.tools : [body.tools]).forEach((tool: any, index: number) => {
      const declarations = tool?.functionDeclarations || tool?.function_declarations;
      if (Array.isArray(declarations)) declarations.forEach((declaration: any, i: number) => add(`tools/${index}/${i}`, "tools", declaration, "tool_schema", null, declaration.name || null));
      else add(`tools/${index}`, "tools", tool, "tool_schema", null, tool?.name || tool?.function?.name || tool?.type || null);
    });
  }
  for (const [key, data] of Object.entries(body)) if (!seen.has(key)) add(`config/${key}`, "config", data, "value", null, key);
  return blocks;
}
export function projectContent(text: string, stream: boolean): TrajectoryProjection {
  if (!stream) {
    try { return { blocks: projectJson(JSON.parse(text)), format: "json", warnings: [] }; }
    catch { return { blocks: [{ id: "raw", section: "other", kind: "text", role: null, name: null, callId: null, value: text }], format: "text", warnings: ["unparsed_body"] }; }
  }
  const values = new Map<string, TrajectoryBlock>();
  const warnings: string[] = [];
  let eventIndex = 0, terminal: any = null;
  const put = (id: string, value: unknown, kind: TrajectoryBlock["kind"] = "value", section: TrajectorySection = "output", name: string | null = null, callId: string | null = null) => {
    values.set(id, { id, section, kind, role: "assistant", name, callId, value });
  };
  const delta = (id: string, text: unknown, kind: TrajectoryBlock["kind"] = "text") => {
    if (typeof text === "string") put(id, String(values.get(id)?.value || "") + text, kind);
  };
  const parser = new EventStreamParser(event => {
    const number = eventIndex++;
    if (event.data === "[DONE]" || ["ping", "keepalive"].includes(event.event)) return;
    let e: any;
    try { e = JSON.parse(event.data); } catch { warnings.push(`invalid_event:${number}`); put(`event/${number}`, event, "value", "other"); return; }
    if (!object(e)) { put(`event/${number}`, e, "value", "other"); return; }
    if (["response.completed", "response.incomplete", "response.failed"].includes(e.type) && object(e.response)) {
      terminal = e.response; return;
    }
    if (e.type === "response.output_text.delta" || e.type === "response.reasoning_summary_text.delta" || e.type === "response.reasoning_text.delta") {
      delta(`response/${e.output_index ?? e.item_id}/${e.type.includes("reasoning") ? "reasoning" : "text"}/${e.content_index ?? e.summary_index ?? 0}`, e.delta, e.type.includes("reasoning") ? "reasoning" : "text"); return;
    }
    if (e.type === "response.output_item.added" && object(e.item)) {
      if (["function_call", "custom_tool_call"].includes(e.item.type)) put(`call/${e.output_index}`, e.item, "tool_call", "output", e.item.name, e.item.call_id); return;
    }
    if (e.type === "response.function_call_arguments.delta" || e.type === "response.custom_tool_call_input.delta") {
      const id = `call/${e.output_index}`, prior: any = values.get(id)?.value || {};
      const key = e.type.includes("custom") ? "input" : "arguments";
      put(id, { ...prior, [key]: (prior[key] || "") + (e.delta || "") }, "tool_call", "output", prior.name || null, prior.call_id || null); return;
    }
    if (e.type === "response.output_item.done" && object(e.item)) {
      if (["function_call", "custom_tool_call"].includes(e.item.type)) put(`call/${e.output_index}`, e.item, "tool_call", "output", e.item.name, e.item.call_id);
      return;
    }
    if (e.type === "message_start") { put("metadata", e.message, "value", "config"); return; }
    if (e.type === "content_block_start") {
      const block = e.content_block || {};
      put(`block/${e.index}`, block, block.type === "tool_use" ? "tool_call" : block.type === "thinking" ? "reasoning" : "message", "output", block.name || null, block.id || null); return;
    }
    if (e.type === "content_block_delta") {
      const id = `block/${e.index}`, previous: any = values.get(id)?.value || {};
      const change = e.delta || {}, field = change.type === "text_delta" ? "text" : change.type === "thinking_delta" ? "thinking" : change.type === "input_json_delta" ? "arguments" : change.type === "signature_delta" ? "signature" : null;
      if (field) put(id, { ...previous, [field]: (previous[field] || "") + (change.partial_json ?? change[field] ?? "") }, field === "arguments" ? "tool_call" : previous.type === "thinking" ? "reasoning" : "message", "output", previous.name || null, previous.id || null);
      else put(`event/${number}`, e, "value", "other");
      return;
    }
    if (e.type === "content_block_stop") {
      const id = `block/${e.index}`, block: any = values.get(id)?.value;
      if (block && typeof block.arguments === "string") {
        try { const { arguments: args, ...rest } = block; put(id, { ...rest, input: JSON.parse(args) }, "tool_call", "output", block.name, block.id); }
        catch { warnings.push(`incomplete_tool_arguments:${e.index}`); }
      }
      return;
    }
    if (e.type === "message_delta") { put("completion", e, "value", "config"); return; }
    if (e.type === "message_stop") return;
    if (Array.isArray(e.choices)) {
      for (const choice of e.choices) {
        const id = `choice/${choice.index ?? 0}`, d = choice.delta || {};
        if (choice.message) put(id, choice.message, "message");
        delta(`${id}/text`, d.content);
        delta(`${id}/reasoning`, d.reasoning_content ?? d.reasoning, "reasoning");
        for (const call of d.tool_calls || []) {
          const key = `${id}/tool/${call.index ?? call.id}`, prior: any = values.get(key)?.value || {};
          const next = { ...prior, id: call.id || prior.id, name: call.function?.name || prior.name, arguments: (prior.arguments || "") + (call.function?.arguments || "") };
          put(key, next, "tool_call", "output", next.name || null, next.id || null);
        }
        if (choice.finish_reason) put(`${id}/finish`, choice.finish_reason, "value", "config");
      }
      if (e.usage) put("usage", e.usage, "value", "config"); return;
    }
    if (Array.isArray(e.candidates)) {
      for (const candidate of e.candidates) {
        const id = `candidate/${candidate.index ?? 0}`;
        for (const [index, part] of (candidate.content?.parts || []).entries()) {
          if (typeof part.text === "string") delta(`${id}/${part.thought ? "reasoning" : "text"}`, part.text, part.thought ? "reasoning" : "text");
          else if (part.functionCall) put(`${id}/call/${number}/${index}`, part.functionCall, "tool_call", "output", part.functionCall.name || null, part.functionCall.id || null);
          else put(`${id}/part/${number}/${index}`, part, "value", "other");
        }
        if (candidate.finishReason) put(`${id}/finish`, candidate.finishReason, "value", "config");
      }
      if (e.usageMetadata) put("usage", e.usageMetadata, "value", "config"); return;
    }
    if (!["response.created", "response.in_progress", "response.content_part.added", "response.content_part.done", "response.output_text.done", "response.function_call_arguments.done", "response.reasoning_summary_text.done", "response.reasoning_summary_part.added", "response.reasoning_summary_part.done"].includes(e.type)) put(`event/${number}`, e, "value", "other");
  }, 20 * 1024 * 1024);
  try { parser.push(new TextEncoder().encode(text)); if (parser.finish()) warnings.push("incomplete_event"); }
  catch { warnings.push("event_parse_limit"); }
  const unknown = [...values.values()].filter(block => block.section === "other");
  return { blocks: terminal ? [...projectJson(terminal), ...unknown] : [...values.values()], format: "sse", warnings: [...new Set(warnings)] };
}
export function semanticDiff(before: unknown, after: unknown): TrajectoryChange[] {
  const changes: TrajectoryChange[] = [];
  const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
  const walk = (a: any, b: any, path: string, hasA = true, hasB = true, depth = 0) => {
    const section = path.split("/").filter(Boolean)[0] || "root";
    if (!hasA || !hasB) { changes.push({ section, path, action: hasA ? "remove" : "add", ...(hasA ? { before: a } : { after: b }) }); return; }
    if (equal(a, b)) return;
    if (depth < 60 && object(a) && object(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, Object.hasOwn(a, key), Object.hasOwn(b, key), depth + 1);
      return;
    }
    if (depth < 60 && Array.isArray(a) && Array.isArray(b)) {
      const identity = (v: any) => object(v) ? v.id || (section === "tools" ? v.name || v.function?.name : undefined) : undefined;
      const idsA = a.map(identity), idsB = b.map(identity);
      if (idsA.every(id => typeof id === "string") && idsB.every(id => typeof id === "string") && new Set(idsA).size === a.length && new Set(idsB).size === b.length) {
        const left = new Map(idsA.map((id, index) => [id, a[index]])), right = new Map(idsB.map((id, index) => [id, b[index]]));
        for (const id of new Set([...idsA, ...idsB])) walk(left.get(id), right.get(id), `${path}/${encodeURIComponent(id)}`, left.has(id), right.has(id), depth + 1);
        const commonA = idsA.filter(id => right.has(id)), commonB = idsB.filter(id => left.has(id));
        if (!equal(commonA, commonB)) changes.push({ section, path: `${path}/@order`, action: "change", before: idsA, after: idsB });
        return;
      }
      let start = 0, end = 0;
      while (start < a.length && start < b.length && equal(a[start], b[start])) start++;
      while (end < a.length - start && end < b.length - start && equal(a[a.length - 1 - end], b[b.length - 1 - end])) end++;
      const left = a.slice(start, a.length - end), right = b.slice(start, b.length - end);
      for (let i = 0; i < Math.max(left.length, right.length); i++) walk(left[i], right[i], `${path}/${start + i}`, i < left.length, i < right.length, depth + 1);
      return;
    }
    changes.push({ section, path, action: "change", before: a, after: b });
  };
  walk(before, after, ""); return changes;
}
