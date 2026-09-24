import { ApiError } from "./security";
import type { ConversionSink, WireProtocol } from "../shared/types";

type Part =
  | { type: "text"; text: string }
  | { type: "call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "result"; id: string; name?: string; text: string };
interface Message {
  role: "user" | "assistant";
  parts: Part[];
}
interface Normal {
  system: string[];
  messages: Message[];
  tools: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  }[];
  max?: number;
  temperature?: number;
  topP?: number;
  stop?: unknown;
  toolChoice?: unknown;
}
function unsupported(feature: string): never {
  throw new ApiError(422, `conversion_unsupported:${feature}`);
}
/** 可丢弃的推理块类型。未列入这里的类型一律照旧抛错——放宽只作用于显式分类过的语义。 */
const REASONING_TYPES = new Set([
  "reasoning",
  "thinking",
  "redacted_thinking",
  "reasoning_text",
  "summary_text",
]);
/** OpenAI Responses 输出里由服务端托管的调用项（非函数工具）。 */
const HOSTED_ITEM_TYPES = new Set([
  "web_search_call",
  "file_search_call",
  "computer_call",
  "computer_call_output",
  "image_generation_call",
  "code_interpreter_call",
  "local_shell_call",
  "mcp_call",
  "mcp_list_tools",
  "mcp_approval_request",
  "custom_tool_call",
  "custom_tool_call_output",
]);
/** Anthropic 内容块里的服务端工具块。 */
const HOSTED_CONTENT_TYPES = new Set([
  "server_tool_use",
  "web_search_tool_result",
  "mcp_tool_use",
  "mcp_tool_result",
]);
function noteDrop(sink: ConversionSink, type: string) {
  const found = sink.dropped.find((item) => item.type === type);
  if (found) found.count++;
  else sink.dropped.push({ type, count: 1 });
}
export const isReasoningType = (type?: string) =>
  !!type && REASONING_TYPES.has(type);
export const isHostedItemType = (type?: string) =>
  !!type && HOSTED_ITEM_TYPES.has(type);
export const isHostedContentType = (type?: string) =>
  !!type && HOSTED_CONTENT_TYPES.has(type);
/** 丢弃明细归类用：推理类（含字段名与 gemini 的 thought）与托管工具类分开记录。 */
const REASONING_DROP_TYPES = new Set([
  ...REASONING_TYPES,
  "reasoning_state",
  "thought",
  "thoughtSignature",
]);
export const isReasoningDrop = (type: string) => REASONING_DROP_TYPES.has(type);
/** 把各协议的 tools 声明归一成扁平函数工具。namespace 分组是无损展开，不计入丢弃。 */
function toolsFrom(list: any[], wire: WireProtocol, sink?: ConversionSink) {
  const output: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  }[] = [];
  const walk = (tool: any) => {
    if (wire === "messages") {
      if (tool.cache_control) unsupported("hosted_or_cached_tool");
      if (tool.type) {
        if (!sink?.hosted) unsupported("hosted_or_cached_tool");
        noteDrop(sink, "hosted_tool");
        return;
      }
      output.push({
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      });
      return;
    }
    if (tool.type === "namespace") {
      for (const inner of tool.tools || []) walk(inner);
      return;
    }
    if (tool.type !== "function") {
      if (!sink?.hosted) unsupported("hosted_tools");
      noteDrop(sink, "hosted_tool");
      return;
    }
    const definition = wire === "chat" ? tool.function : tool;
    output.push({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    });
  };
  for (const tool of list) walk(tool);
  return output;
}
function argumentsObject(value: unknown) {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        return parsed;
    } catch {}
    unsupported("tool_arguments");
  }
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}
function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .map((part) => {
        if (
          part?.type === "text" ||
          part?.type === "input_text" ||
          part?.type === "output_text"
        )
          return part.text || "";
        return unsupported(part?.type || "content");
      })
      .join("\n");
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}
function normalize(
  body: any,
  wire: WireProtocol,
  sink?: ConversionSink,
): Normal {
  if (body.n > 1 || body.generationConfig?.candidateCount > 1)
    unsupported("multiple_candidates");
  if (body.previous_response_id || body.conversation)
    unsupported("stateful_context");
  if (
    body.response_format ||
    body.text?.format ||
    body.output_config?.format ||
    body.generationConfig?.responseSchema ||
    body.generationConfig?.responseJsonSchema
  )
    unsupported("structured_output");
  if (
    sink?.reasoning &&
    (body.reasoning || body.thinking || body.generationConfig?.thinkingConfig)
  )
    noteDrop(sink, "reasoning_state");
  else if (
    body.reasoning ||
    body.thinking ||
    body.generationConfig?.thinkingConfig
  )
    unsupported("reasoning_state");
  const output: Normal = {
    system: [],
    messages: [],
    tools: [],
    max:
      body.max_output_tokens ??
      body.max_completion_tokens ??
      body.max_tokens ??
      body.generationConfig?.maxOutputTokens,
    temperature: body.temperature ?? body.generationConfig?.temperature,
    topP: body.top_p ?? body.generationConfig?.topP,
    stop:
      body.stop ?? body.stop_sequences ?? body.generationConfig?.stopSequences,
  };
  const names = new Map<string, string>();
  const append = (role: Message["role"], parts: Part[]) => {
    if (parts.length) output.messages.push({ role, parts });
  };
  if (wire === "gemini") {
    if (body.cachedContent) unsupported("cached_content");
    if (body.systemInstruction)
      output.system.push(
        (body.systemInstruction.parts || [])
          .map((p: any) => {
            if (typeof p.text !== "string") unsupported("system_content");
            return p.text;
          })
          .join("\n"),
      );
    for (const msg of body.contents || []) {
      const parts: Part[] = [];
      for (const p of msg.parts || []) {
        if (sink?.reasoning && p.thought === true) {
          noteDrop(sink, "thought");
          continue;
        }
        if (typeof p.text === "string")
          parts.push({ type: "text", text: p.text });
        else if (p.functionCall) {
          const id = p.functionCall.id || crypto.randomUUID();
          names.set(id, p.functionCall.name);
          parts.push({
            type: "call",
            id,
            name: p.functionCall.name,
            args: argumentsObject(p.functionCall.args),
          });
        } else if (p.functionResponse) {
          parts.push({
            type: "result",
            id:
              p.functionResponse.id ||
              [...names.entries()]
                .reverse()
                .find(([, name]) => name === p.functionResponse.name)?.[0] ||
              unsupported("missing_tool_call"),
            name: p.functionResponse.name,
            text: JSON.stringify(p.functionResponse.response),
          });
        } else if (sink?.reasoning && (p.thoughtSignature || p.thought))
          noteDrop(sink, "thought");
        else unsupported("multimodal_or_signature");
      }
      append(msg.role === "model" ? "assistant" : "user", parts);
    }
    for (const group of body.tools || []) {
      if (!group.functionDeclarations) {
        if (!sink?.hosted) unsupported("hosted_tools");
        noteDrop(sink, "hosted_tool");
        continue;
      }
      for (const tool of group.functionDeclarations)
        output.tools.push({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters || { type: "object", properties: {} },
        });
    }
    if (body.toolConfig) unsupported("tool_choice");
  } else {
    if (body.instructions) output.system.push(String(body.instructions));
    if (body.system) output.system.push(textContent(body.system));
    let messages = wire === "responses" ? body.input : body.messages;
    if (typeof messages === "string")
      messages = [{ role: "user", content: messages }];
    for (const message of messages || []) {
      if (message.type === "function_call") {
        const id = message.call_id || message.id;
        names.set(id, message.name);
        append("assistant", [
          {
            type: "call",
            id,
            name: message.name,
            args: argumentsObject(message.arguments),
          },
        ]);
        continue;
      }
      if (message.type === "function_call_output") {
        append("user", [
          {
            type: "result",
            id: message.call_id,
            name: names.get(message.call_id),
            text: textContent(message.output),
          },
        ]);
        continue;
      }
      if (message.type && message.type !== "message") {
        if (sink?.reasoning && REASONING_TYPES.has(message.type))
          noteDrop(sink, message.type);
        else if (sink?.hosted && HOSTED_ITEM_TYPES.has(message.type))
          noteDrop(sink, message.type);
        else unsupported(message.type);
        continue;
      }
      if (["system", "developer"].includes(message.role)) {
        output.system.push(textContent(message.content));
        continue;
      }
      if (message.role === "tool") {
        append("user", [
          {
            type: "result",
            id: message.tool_call_id,
            name: names.get(message.tool_call_id),
            text: textContent(message.content),
          },
        ]);
        continue;
      }
      if (!["user", "assistant"].includes(message.role))
        unsupported("message_role");
      const parts: Part[] = [];
      if (typeof message.content === "string")
        parts.push({ type: "text", text: message.content });
      else
        for (const part of message.content || []) {
          if (part.cache_control) unsupported("cache_control");
          if (["text", "input_text", "output_text"].includes(part.type))
            parts.push({ type: "text", text: part.text });
          else if (part.type === "tool_use") {
            names.set(part.id, part.name);
            parts.push({
              type: "call",
              id: part.id,
              name: part.name,
              args: argumentsObject(part.input),
            });
          } else if (part.type === "tool_result")
            parts.push({
              type: "result",
              id: part.tool_use_id,
              name: names.get(part.tool_use_id),
              text: textContent(part.content),
            });
          else if (sink?.reasoning && REASONING_TYPES.has(part.type))
            noteDrop(sink, part.type);
          else unsupported(part.type || "content");
        }
      for (const call of message.tool_calls || []) {
        if (call.type !== "function") unsupported("custom_tool");
        names.set(call.id, call.function.name);
        parts.push({
          type: "call",
          id: call.id,
          name: call.function.name,
          args: argumentsObject(call.function.arguments),
        });
      }
      append(message.role, parts);
    }
    output.tools = toolsFrom(body.tools || [], wire, sink);
    if (
      body.tool_choice !== undefined &&
      !["auto", "none"].includes(body.tool_choice)
    )
      unsupported("tool_choice");
    output.toolChoice = body.tool_choice;
  }
  return output;
}
export function convertRequest(
  body: any,
  from: WireProtocol,
  to: WireProtocol,
  model: string,
  sink?: ConversionSink,
) {
  if (from === to) return { ...body, model };
  const n = normalize(body, from, sink);
  const result: any = { model };
  const common = {
    ...(n.temperature !== undefined ? { temperature: n.temperature } : {}),
    ...(n.topP !== undefined ? { top_p: n.topP } : {}),
  };
  const toolNames = new Map<string, string>();
  for (const message of n.messages)
    for (const part of message.parts)
      if (part.type === "call") toolNames.set(part.id, part.name);
  if (to === "messages") {
    Object.assign(result, common, { max_tokens: n.max || 8192, messages: [] });
    if (n.system.length) result.system = n.system.join("\n\n");
    if (n.stop)
      result.stop_sequences = Array.isArray(n.stop) ? n.stop : [n.stop];
    for (const message of n.messages) {
      const content = message.parts.map((p) =>
        p.type === "text"
          ? { type: "text", text: p.text }
          : p.type === "call"
            ? { type: "tool_use", id: p.id, name: p.name, input: p.args }
            : { type: "tool_result", tool_use_id: p.id, content: p.text },
      );
      result.messages.push({ role: message.role, content });
    }
    if (n.tools.length)
      result.tools = n.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    if (n.toolChoice === "none") delete result.tools;
  } else if (to === "chat") {
    Object.assign(result, common, {
      messages: n.system.length
        ? [{ role: "system", content: n.system.join("\n\n") }]
        : [],
    });
    if (n.max) result.max_completion_tokens = n.max;
    if (n.stop) result.stop = n.stop;
    for (const message of n.messages) {
      if (message.role === "user") {
        let text = "";
        const flush = () => {
          if (text) {
            result.messages.push({ role: "user", content: text });
            text = "";
          }
        };
        for (const part of message.parts) {
          if (part.type === "text") text += (text ? "\n" : "") + part.text;
          else if (part.type === "result") {
            flush();
            result.messages.push({
              role: "tool",
              tool_call_id: part.id,
              content: part.text,
            });
          } else unsupported("user_tool_call");
        }
        flush();
      } else {
        const firstCall = message.parts.findIndex((p) => p.type === "call");
        if (
          firstCall >= 0 &&
          message.parts.slice(firstCall).some((p) => p.type === "text")
        )
          unsupported("interleaved_assistant_content");
        if (message.parts.some((p) => p.type === "result"))
          unsupported("assistant_tool_result");
        const text = message.parts
          .filter((p) => p.type === "text")
          .map((p) => (p as any).text)
          .join("\n");
        const calls = message.parts
          .filter((p) => p.type === "call")
          .map((p) => ({
            id: (p as any).id,
            type: "function",
            function: {
              name: (p as any).name,
              arguments: JSON.stringify((p as any).args),
            },
          }));
        result.messages.push({
          role: "assistant",
          content: text || null,
          ...(calls.length ? { tool_calls: calls } : {}),
        });
      }
    }
    if (n.tools.length)
      result.tools = n.tools.map((t) => ({ type: "function", function: t }));
    if (n.toolChoice) result.tool_choice = n.toolChoice;
  } else if (to === "responses") {
    Object.assign(result, common, { input: [] });
    if (n.max) result.max_output_tokens = n.max;
    if (n.system.length) result.instructions = n.system.join("\n\n");
    if (n.stop) unsupported("responses_stop_sequence");
    for (const message of n.messages) {
      let text = "";
      const flush = () => {
        if (text) {
          result.input.push({ role: message.role, content: text });
          text = "";
        }
      };
      for (const p of message.parts) {
        if (p.type === "text") text += (text ? "\n" : "") + p.text;
        else {
          flush();
          if (p.type === "call")
            result.input.push({
              type: "function_call",
              call_id: p.id,
              name: p.name,
              arguments: JSON.stringify(p.args),
            });
          else
            result.input.push({
              type: "function_call_output",
              call_id: p.id,
              output: p.text,
            });
        }
      }
      flush();
    }
    if (n.tools.length)
      result.tools = n.tools.map((t) => ({ type: "function", ...t }));
    if (n.toolChoice) result.tool_choice = n.toolChoice;
  } else {
    delete result.model;
    result.contents = n.messages.map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: message.parts.map((p) => {
        if (p.type === "text") return { text: p.text };
        if (p.type === "call")
          return { functionCall: { id: p.id, name: p.name, args: p.args } };
        const name = p.name || toolNames.get(p.id);
        if (!name) unsupported("missing_tool_name");
        let response: unknown;
        try {
          response = JSON.parse(p.text);
        } catch {
          response = { result: p.text };
        }
        return {
          functionResponse: {
            id: p.id,
            name,
            response:
              response && typeof response === "object"
                ? response
                : { result: response },
          },
        };
      }),
    }));
    if (n.system.length)
      result.systemInstruction = { parts: [{ text: n.system.join("\n\n") }] };
    result.generationConfig = {
      ...(n.max ? { maxOutputTokens: n.max } : {}),
      ...(n.temperature !== undefined ? { temperature: n.temperature } : {}),
      ...(n.topP !== undefined ? { topP: n.topP } : {}),
      ...(n.stop
        ? { stopSequences: Array.isArray(n.stop) ? n.stop : [n.stop] }
        : {}),
    };
    if (n.tools.length && n.toolChoice !== "none")
      result.tools = [{ functionDeclarations: n.tools }];
  }
  return result;
}
interface Answer {
  text: string;
  calls: { id: string; name: string; args: Record<string, unknown> }[];
  input: number;
  output: number;
  limited: boolean;
}
function responsePayload(
  body: any,
  from: WireProtocol,
  to: WireProtocol,
  model: string,
  sink?: ConversionSink,
) {
  const answer: Answer = {
    text: "",
    calls: [],
    input: 0,
    output: 0,
    limited: false,
  };
  if (from === "chat") {
    const choice = body.choices?.[0];
    if (!choice) throw new ApiError(502, "invalid_upstream_response");
    answer.text = textContent(choice.message?.content);
    answer.calls = (choice.message?.tool_calls || []).map((c: any) => ({
      id: c.id,
      name: c.function.name,
      args: argumentsObject(c.function.arguments),
    }));
    answer.input = body.usage?.prompt_tokens || 0;
    answer.output = body.usage?.completion_tokens || 0;
    answer.limited = choice.finish_reason === "length";
  } else if (from === "messages") {
    for (const p of body.content || []) {
      if (p.type === "text") answer.text += p.text;
      else if (p.type === "tool_use")
        answer.calls.push({ id: p.id, name: p.name, args: p.input });
      else if (sink?.reasoning && REASONING_TYPES.has(p.type))
        noteDrop(sink, p.type);
      else if (sink?.hosted && HOSTED_CONTENT_TYPES.has(p.type))
        noteDrop(sink, p.type);
      else unsupported("response_signature_or_thinking");
    }
    answer.input =
      (body.usage?.input_tokens || 0) +
      (body.usage?.cache_read_input_tokens || 0) +
      (body.usage?.cache_creation_input_tokens || 0);
    answer.output = body.usage?.output_tokens || 0;
    answer.limited = body.stop_reason === "max_tokens";
  } else if (from === "responses") {
    for (const item of body.output || []) {
      if (item.type === "message") answer.text += textContent(item.content);
      else if (item.type === "function_call")
        answer.calls.push({
          id: item.call_id,
          name: item.name,
          args: argumentsObject(item.arguments),
        });
      else if (sink?.reasoning && REASONING_TYPES.has(item.type))
        noteDrop(sink, item.type);
      else if (sink?.hosted && HOSTED_ITEM_TYPES.has(item.type))
        noteDrop(sink, item.type);
      else unsupported("response_reasoning_or_hosted_tool");
    }
    answer.input = body.usage?.input_tokens || 0;
    answer.output = body.usage?.output_tokens || 0;
    answer.limited = body.status === "incomplete";
  } else {
    const candidate = body.candidates?.[0];
    if (!candidate) throw new ApiError(502, "invalid_upstream_response");
    for (const p of candidate.content?.parts || []) {
      if (p.thought === true && sink?.reasoning) {
        noteDrop(sink, "thought");
        continue;
      }
      if (p.thoughtSignature || p.thought) {
        if (!sink?.reasoning) unsupported("response_thought_signature");
        noteDrop(sink, "thoughtSignature");
      }
      if (typeof p.text === "string") answer.text += p.text;
      else if (p.functionCall)
        answer.calls.push({
          id: p.functionCall.id || crypto.randomUUID(),
          name: p.functionCall.name,
          args: p.functionCall.args || {},
        });
      else unsupported("response_media");
    }
    answer.input = body.usageMetadata?.promptTokenCount || 0;
    answer.output =
      (body.usageMetadata?.candidatesTokenCount || 0) +
      (body.usageMetadata?.thoughtsTokenCount || 0);
    answer.limited = candidate.finishReason === "MAX_TOKENS";
  }
  const id = `pgw_${crypto.randomUUID().replaceAll("-", "")}`;
  if (to === "chat")
    return {
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: answer.text || null,
            ...(answer.calls.length
              ? {
                  tool_calls: answer.calls.map((c) => ({
                    id: c.id,
                    type: "function",
                    function: {
                      name: c.name,
                      arguments: JSON.stringify(c.args),
                    },
                  })),
                }
              : {}),
          },
          finish_reason: answer.calls.length
            ? "tool_calls"
            : answer.limited
              ? "length"
              : "stop",
        },
      ],
      usage: {
        prompt_tokens: answer.input,
        completion_tokens: answer.output,
        total_tokens: answer.input + answer.output,
      },
    };
  if (to === "messages")
    return {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [
        ...(answer.text ? [{ type: "text", text: answer.text }] : []),
        ...answer.calls.map((c) => ({
          type: "tool_use",
          id: c.id,
          name: c.name,
          input: c.args,
        })),
      ],
      stop_reason: answer.calls.length
        ? "tool_use"
        : answer.limited
          ? "max_tokens"
          : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: answer.input, output_tokens: answer.output },
    };
  if (to === "responses")
    return {
      id,
      object: "response",
      model,
      created_at: Math.floor(Date.now() / 1000),
      status: answer.limited ? "incomplete" : "completed",
      output: [
        ...(answer.text
          ? [
              {
                id: `msg_${id}`,
                type: "message",
                role: "assistant",
                status: "completed",
                content: [
                  { type: "output_text", text: answer.text, annotations: [] },
                ],
              },
            ]
          : []),
        ...answer.calls.map((c) => ({
          id: `fc_${c.id}`,
          type: "function_call",
          call_id: c.id,
          name: c.name,
          arguments: JSON.stringify(c.args),
          status: "completed",
        })),
      ],
      usage: {
        input_tokens: answer.input,
        output_tokens: answer.output,
        total_tokens: answer.input + answer.output,
      },
    };
  return {
    candidates: [
      {
        index: 0,
        content: {
          role: "model",
          parts: [
            ...(answer.text ? [{ text: answer.text }] : []),
            ...answer.calls.map((c) => ({
              functionCall: { id: c.id, name: c.name, args: c.args },
            })),
          ],
        },
        finishReason: answer.limited ? "MAX_TOKENS" : "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: answer.input,
      candidatesTokenCount: answer.output,
      totalTokenCount: answer.input + answer.output,
    },
  };
}
export function convertResponse(
  body: any,
  from: WireProtocol,
  to: WireProtocol,
  model: string,
  sink?: ConversionSink,
) {
  const result: any = responsePayload(body, from, to, model, sink);
  if (!body.usage && !body.usageMetadata) {
    delete result.usage;
    delete result.usageMetadata;
  }
  return result;
}
export function responseEvents(body: any, wire: WireProtocol) {
  const events: any[] = [];
  const emit = (type: string, data: any) =>
    events.push(
      `event: ${type}\ndata: ${JSON.stringify(wire === "responses" ? { sequence_number: events.length, ...data } : data)}\n\n`,
    );
  if (wire === "gemini") {
    emit("message", body);
    return events.join("");
  }
  if (wire === "chat") {
    const choice = body.choices[0];
    const message = choice.message;
    emit("message", {
      ...body,
      object: "chat.completion.chunk",
      usage: null,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            ...(message.content ? { content: message.content } : {}),
          },
          finish_reason: null,
        },
      ],
    });
    for (const [index, call] of (message.tool_calls || []).entries())
      emit("message", {
        ...body,
        object: "chat.completion.chunk",
        usage: null,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index, ...call }] },
            finish_reason: null,
          },
        ],
      });
    emit("message", {
      ...body,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }],
    });
    events.push("data: [DONE]\n\n");
    return events.join("");
  }
  if (wire === "messages") {
    emit("message_start", {
      type: "message_start",
      message: {
        ...body,
        content: [],
        stop_reason: null,
        usage: { input_tokens: body.usage.input_tokens, output_tokens: 0 },
      },
    });
    for (const [index, part] of body.content.entries()) {
      emit("content_block_start", {
        type: "content_block_start",
        index,
        content_block:
          part.type === "text"
            ? { type: "text", text: "" }
            : { ...part, input: {} },
      });
      emit("content_block_delta", {
        type: "content_block_delta",
        index,
        delta:
          part.type === "text"
            ? { type: "text_delta", text: part.text }
            : {
                type: "input_json_delta",
                partial_json: JSON.stringify(part.input),
              },
      });
      emit("content_block_stop", { type: "content_block_stop", index });
    }
    emit("message_delta", {
      type: "message_delta",
      delta: { stop_reason: body.stop_reason, stop_sequence: null },
      usage: { output_tokens: body.usage.output_tokens },
    });
    emit("message_stop", { type: "message_stop" });
    return events.join("");
  }
  emit("response.created", {
    type: "response.created",
    response: { ...body, status: "in_progress", output: [] },
  });
  let sequence = 1;
  for (const [index, item] of body.output.entries()) {
    emit("response.output_item.added", {
      type: "response.output_item.added",
      sequence_number: sequence++,
      output_index: index,
      item: {
        ...item,
        status: "in_progress",
        ...(item.type === "message" ? { content: [] } : { arguments: "" }),
      },
    });
    if (item.type === "message") {
      for (const [contentIndex, part] of item.content.entries()) {
        emit("response.content_part.added", {
          type: "response.content_part.added",
          sequence_number: sequence++,
          item_id: item.id,
          output_index: index,
          content_index: contentIndex,
          part: { ...part, text: "" },
        });
        emit("response.output_text.delta", {
          type: "response.output_text.delta",
          sequence_number: sequence++,
          item_id: item.id,
          output_index: index,
          content_index: contentIndex,
          delta: part.text,
        });
        emit("response.output_text.done", {
          type: "response.output_text.done",
          sequence_number: sequence++,
          item_id: item.id,
          output_index: index,
          content_index: contentIndex,
          text: part.text,
        });
        emit("response.content_part.done", {
          type: "response.content_part.done",
          sequence_number: sequence++,
          item_id: item.id,
          output_index: index,
          content_index: contentIndex,
          part,
        });
      }
    } else {
      emit("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        sequence_number: sequence++,
        item_id: item.id,
        output_index: index,
        delta: item.arguments,
      });
      emit("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        sequence_number: sequence++,
        item_id: item.id,
        output_index: index,
        arguments: item.arguments,
      });
    }
    emit("response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: sequence++,
      output_index: index,
      item,
    });
  }
  emit(`response.${body.status}`, {
    type: `response.${body.status}`,
    sequence_number: sequence++,
    response: body,
  });
  return events.join("");
}
