import { mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { AgentProcess } from "./agent-process";
import { home, address, version } from "./config";
import { ApiError } from "./security";
import { protocolBase } from "../shared/endpoints";
import type { Run, ModelRoute } from "../shared/types";

export interface TurnResult { status: "completed" | "failed" | "interrupted" | "blocked"; text: string; error?: string }
export interface NativeRequest { id: string | number; method: string; params: Record<string, unknown> }
export interface AdapterHooks {
  output: (text: string) => void;
  identity: (sessionId: string, turnId?: string | null) => Promise<void>;
  event: (kind: string, detail: Record<string, unknown>) => Promise<void>;
  approval: (request: NativeRequest, answer: (value: Record<string, unknown>) => void) => Promise<void>;
}
export interface AgentAdapter {
  turn: (message: string) => Promise<TurnResult>;
  steer: (message: string) => Promise<void>;
  interrupt: () => Promise<void>;
  close: () => Promise<void>;
}
export async function createAdapter(run: Run, route: ModelRoute, key: string, hooks: AdapterHooks): Promise<AgentAdapter> {
  const executable = Bun.which(run.agent);
  if (!executable) throw new ApiError(409, "agent_not_installed");
  const dir = join(home, "runs", run.id, run.agent);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const env = { ...process.env };
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"]) delete env[name];
  env.PGW_MODEL_KEY = key;
  env.PGW_MCP_KEY = key;
  const hasMcp = !!run.controls.memoryAccess || !!run.controls.mcpGrants?.length;
  const output = (text: string) => hooks.output(text.replaceAll(key, "[redacted]"));
  let native: AgentProcess | undefined;
  let session = run.nativeSessionId;
  let turnId = run.nativeTurnId;
  let current: { resolve: (result: TurnResult) => void; text: string } | undefined;
  const finish = (result: Omit<TurnResult, "text">) => { const pending = current; current = undefined; pending?.resolve({ ...result, text: pending.text }); };
  const failure = (error: Error) => finish({ status: "failed", error: error.message });
  const append = (text: string) => { output(text); if (current) current.text = (current.text + text).slice(-250000); };
  const observeExit = (child: AgentProcess) => { void child.exited.then(async code => { await child.drained(); if (native === child && current) finish({ status: "failed", error: `agent_exited:${code}` }); }); };
  if (run.agent === "codex") {
    const config = `model = ${JSON.stringify(route.alias)}\nmodel_provider = "pgw"\napproval_policy = "on-request"\nsandbox_mode = ${JSON.stringify(run.controls.permission)}\n[model_providers.pgw]\nname = "Personal Gateway"\nbase_url = ${JSON.stringify(protocolBase(address,"responses"))}\nenv_key = "PGW_MODEL_KEY"\nwire_api = "responses"\n`;
    const mcpConfig = hasMcp ? `\n[mcp_servers.personal_gateway]\nurl = ${JSON.stringify(`${address}/mcp`)}\nbearer_token_env_var = "PGW_MCP_KEY"\ntool_timeout_sec = 180\n` : "";
    const configPath = join(dir, "config.toml"); await Bun.write(configPath, config + mcpConfig); await chmod(configPath, 0o600);
    env.CODEX_HOME = dir;
    native = new AgentProcess([executable, "app-server", "--listen", "stdio://"], { cwd: run.workspace, env, onStderr: output, onError: failure,
      onEvent: async event => {
        const p = event.params || {};
        if (event.id !== undefined && event.method) {
          await hooks.approval({ id: event.id, method: event.method, params: p }, result => native!.send({ id: event.id, result }));
          return;
        }
        if (event.method === "turn/started") { turnId = p.turn.id; await hooks.identity(session!, turnId); }
        else if (event.method === "item/agentMessage/delta") append(p.delta || "");
        else if (event.method === "item/commandExecution/outputDelta") output(p.delta || "");
        else if (event.method === "item/completed") await hooks.event("native.item", { id: p.item?.id, type: p.item?.type, status: p.item?.status });
        else if (event.method === "turn/completed") { await hooks.event("native.turn", { id: p.turn?.id, status: p.turn?.status }); finish({ status: p.turn?.status === "completed" ? "completed" : p.turn?.status === "interrupted" ? "interrupted" : "failed", error: p.turn?.error?.message }); }
        else if (event.method === "serverRequest/resolved") await hooks.event("native.request_resolved", { requestId: p.requestId });
      },
    });
    observeExit(native);
    try {
      await native.request("initialize", { clientInfo: { name: "personal_gateway", title: "Personal Gateway", version }, capabilities: { experimentalApi: true } });
      native.send({ method: "initialized", params: {} });
      const response = await native.request(session ? "thread/resume" : "thread/start", { ...(session ? { threadId: session } : {}), cwd: run.workspace,
        model: route.alias, modelProvider: "pgw", approvalPolicy: "on-request", sandbox: run.controls.permission });
      session = response.thread.id; await hooks.identity(session!);
    } catch (error) { await native.close(); throw error; }
  } else if (run.agent === "pi") {
    if (run.controls.permission !== "read-only") throw new ApiError(409, "pi_workspace_sandbox_required");
    env.PI_CODING_AGENT_DIR = dir;
    const api = route.protocol === "messages" ? "anthropic-messages" : route.protocol === "responses" ? "openai-responses" : "openai-completions";
    await Bun.write(join(dir, "models.json"), JSON.stringify({ providers: { pgw: { baseUrl: route.protocol === "messages" ? `${protocolBase(address,route.protocol)}/v1` : protocolBase(address,route.protocol), apiKey: "$PGW_MODEL_KEY", api,
      models: [{ id: route.alias, name: route.alias, contextWindow: route.contextLimit, maxTokens: route.outputLimit }] } } }));
    session ||= run.id;
    const sessionDir = join(dir, "sessions");
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    native = new AgentProcess([executable, "--mode", "rpc", "--provider", "pgw", "--model", route.alias, "--session-id", session, "--session-dir", sessionDir, "--tools", "read,grep,find,ls", "--no-extensions"], {
      cwd: run.workspace, env, onStderr: output, onError: failure,
      onEvent: async event => {
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") append(event.assistantMessageEvent.delta || "");
        else if (event.type === "agent_settled") finish({ status: "completed" });
        else if (event.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(event.method)) await hooks.approval({ id: event.id, method: "pi/input", params: event }, response => native!.send({ type: "extension_ui_response", id: event.id, ...response }));
        else if (event.type === "message_end" && event.message?.role === "assistant" && event.message?.stopReason === "error") finish({ status: "failed", error: event.message.errorMessage || "agent_error" });
      },
    });
    observeExit(native);
    try { const state = await native.request("get_state", {}, true); session = state.sessionId || session; await hooks.identity(session!); }
    catch (error) { await native.close(); throw error; }
  }
  return {
    async turn(message) {
      if (current) throw new ApiError(409, "turn_in_progress");
      const result = new Promise<TurnResult>(resolve => { current = { resolve, text: "" }; });
      if (run.agent === "codex") {
        try { const response = await native!.request("turn/start", { threadId: session, input: [{ type: "text", text: message, text_elements: [] }] }); turnId = response.turn.id; await hooks.identity(session!, turnId); }
        catch (error) { failure(error as Error); }
      } else if (run.agent === "pi") {
        try { await native!.request("prompt", { message }, true); } catch (error) { failure(error as Error); }
      } else {
        env.CLAUDE_CONFIG_DIR = dir;
        env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
        env.ANTHROPIC_BASE_URL = protocolBase(address,"messages"); env.ANTHROPIC_AUTH_TOKEN = key;
        env.ANTHROPIC_MODEL = route.alias; env.ANTHROPIC_DEFAULT_SONNET_MODEL = route.alias; env.ANTHROPIC_DEFAULT_OPUS_MODEL = route.alias; env.ANTHROPIC_DEFAULT_HAIKU_MODEL = route.alias;
        const existing = session;
        session ||= crypto.randomUUID();
        await hooks.identity(session);
        const mcpFile = join(dir, "mcp.json");
        if (hasMcp) { await Bun.write(mcpFile, JSON.stringify({ mcpServers: { personal_gateway: { type: "http", url: `${address}/mcp`, headers: { Authorization: "Bearer ${PGW_MCP_KEY}" } } } })); await chmod(mcpFile, 0o600); }
        const args = [executable, "-p", ...(hasMcp ? ["--mcp-config", mcpFile] : []), "--output-format", "stream-json", "--verbose", "--model", route.alias,
          ...(existing ? ["--resume", session] : ["--session-id", session]),
          ...(run.controls.permission === "read-only" ? ["--tools", "Read,Glob,Grep"] : []), "--", message];
        await native?.close();
        native = new AgentProcess(args, { cwd: run.workspace, env, onStderr: output, onError: failure,
          onEvent: async event => {
            if (event.session_id) { session = event.session_id; await hooks.identity(session!); }
            if (event.type === "assistant") {
              for (const part of event.message?.content || []) if (part.type === "text") append(part.text + "\n");
            } else if (event.type === "result") {
              const denied = event.permission_denials?.length > 0;
              finish({ status: denied ? "blocked" : event.is_error ? "failed" : "completed", error: denied ? "native_permission_required" : event.is_error ? event.subtype : undefined });
            }
          },
        });
        native.child.stdin.end();
        observeExit(native);
      }
      return result;
    },
    async steer(message) {
      if (!current) throw new ApiError(409, "run_not_active");
      if (run.agent === "codex") await native!.request("turn/steer", { threadId: session, expectedTurnId: turnId, input: [{ type: "text", text: message, text_elements: [] }] });
      else if (run.agent === "pi") await native!.request("steer", { message }, true);
      else throw new ApiError(409, "steering_not_supported");
    },
    async interrupt() {
      if (!current) return;
      try {
        if (run.agent === "codex" && turnId) await native!.request("turn/interrupt", { threadId: session, turnId });
        else if (run.agent === "pi") { await native!.request("clear_queue", {}, true); await native!.request("abort", {}, true); }
        else await native?.close();
      } finally { finish({ status: "interrupted" }); }
    },
    async close() { finish({ status: "interrupted" }); await native?.close(); },
  };
}
