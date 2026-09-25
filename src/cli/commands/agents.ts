import { chmod, mkdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { mcpAlias } from "../../server/mcp";
import { protocolBase, upstreamWireOf } from "../../shared/endpoints";
import { MODEL_ALIAS_ANY, pickRoute } from "../../shared/routes";
import type { ModelRoute, PublicClient, PublicProvider, WireProtocol } from "../../shared/types";
import { address, home } from "../context";
import { writeValue } from "../output";
import type { CliContext } from "../types";

async function noteConvertedRoute(context: CliContext, route: ModelRoute, inbound: WireProtocol) {
  const [providers, settings] = await Promise.all([
    context.request<PublicProvider[]>("/providers"),
    context.request<{ protocolConversion: boolean }>("/settings"),
  ]);
  const usable = route.targets.flatMap((target) => {
    const provider = providers.find((item) => item.id === target.providerId && item.enabled);
    return provider ? [{ target, provider }] : [];
  });
  const converting = usable.filter((item) => upstreamWireOf(inbound, item.target.protocol, item.provider.protocol) !== inbound);
  if (!converting.length) return;
  if (converting.length === usable.length && !settings.protocolConversion) throw new Error(`Route ${route.alias} needs protocol conversion, but it is disabled: ${address}`);
  process.stderr.write(`pgw: ${route.alias} is a ${route.protocol} route; the ${inbound} entry converts it before the upstream.\n`);
}

export async function wrapAgent(context: CliContext, agent: "claude" | "codex" | "pi", raw: string[]) {
  const executable = Bun.which(agent);
  if (!executable) throw new Error(`${agent}: executable not found`);
  await context.ensureServer();
  const routes = await context.request<ModelRoute[]>("/routes");
  const protocol = agent === "claude" ? "messages" : agent === "codex" ? "responses" : null;
  const pick = pickRoute(routes, protocol, process.env.PGW_MODEL);
  if (!pick) throw new Error(`Configure a ${protocol || "compatible"} route: ${address}`);
  const route = pick.route;
  if (pick.fallback && protocol) await noteConvertedRoute(context, route, protocol);
  const requestedAlias = process.env.PGW_ALIAS?.trim();
  const transparent = ["1", "true"].includes((process.env.PGW_TRANSPARENT || "").trim().toLowerCase());
  const injectModel = transparent ? null : requestedAlias || route.alias;
  const modelAliases = transparent && agent !== "pi" ? [{ name: MODEL_ALIAS_ANY, routeId: route.id }] : requestedAlias ? [{ name: requestedAlias, routeId: route.id }] : [];
  const workspace = await realpath(process.cwd());
  const access = context.options.access ? (await context.request<PublicClient[]>("/clients")).find((client) => client.id === context.options.access && client.enabled) : undefined;
  if (context.options.access && !access) throw new Error("MCP access not found");
  if (access?.project && (await realpath(access.project)) !== workspace) throw new Error("MCP access belongs to another project");
  if (agent === "pi" && access) throw new Error("Pi MCP launch requires an explicit extension; use codex or claude for this access");
  const client = await context.request<PublicClient & { key: string }>("/clients", "POST", {
    kind: "long_term", expiresAt: null, mcpGrants: access?.mcpGrants || [], memoryAccess: access?.memoryAccess || false,
    name: `${agent}:${process.pid}`, project: workspace, personalize: true, routeIds: [route.id], ...(modelAliases.length ? { modelAliases } : {}),
  });
  const environment: Record<string, string | undefined> = { ...process.env };
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"]) delete environment[key];
  const nativeArgs = raw[0] === "--" ? raw.slice(1) : raw;
  let argv: string[];
  let mcpConfig: string | undefined;
  let claudeConfigDir: string | undefined;
  const hasMcp = client.memoryAccess || client.mcpGrants.length > 0;
  environment.PGW_MCP_KEY = client.key;
  try {
    if (agent === "codex") {
      const originalHome = process.env.CODEX_HOME || join(homedir(), ".codex");
      const configHome = (await Bun.file(join(originalHome, "config.toml")).exists()) ? originalHome : join(home, "agents", "codex");
      await mkdir(configHome, { recursive: true, mode: 0o700 });
      environment.CODEX_HOME = configHome;
      environment.PGW_MODEL_KEY = client.key;
      argv = [executable, ...nativeArgs, "-c", 'model_provider="pgw"', ...(injectModel === null ? [] : ["-c", `model=${JSON.stringify(injectModel)}`]), "-c", 'model_providers.pgw.name="Personal Gateway"', "-c", `model_providers.pgw.base_url=${JSON.stringify(protocolBase(address, "responses"))}`, "-c", 'model_providers.pgw.env_key="PGW_MODEL_KEY"', "-c", 'model_providers.pgw.wire_api="responses"', ...(hasMcp ? ["-c", `mcp_servers.personal_gateway.url=${JSON.stringify(`${address}/mcp`)}`, "-c", 'mcp_servers.personal_gateway.bearer_token_env_var="PGW_MCP_KEY"', "-c", "mcp_servers.personal_gateway.tool_timeout_sec=180"] : [])];
    } else if (agent === "claude") {
      environment.ANTHROPIC_BASE_URL = protocolBase(address, "messages");
      environment.ANTHROPIC_AUTH_TOKEN = client.key;
      if (injectModel !== null) {
        environment.ANTHROPIC_MODEL = injectModel;
        environment.ANTHROPIC_DEFAULT_SONNET_MODEL = injectModel;
        environment.ANTHROPIC_DEFAULT_OPUS_MODEL = injectModel;
        environment.ANTHROPIC_DEFAULT_HAIKU_MODEL = injectModel;
      }
      claudeConfigDir = join(home, "launches", client.id);
      await mkdir(claudeConfigDir, { recursive: true, mode: 0o700 });
      const settings = join(claudeConfigDir, "settings.json");
      await Bun.write(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: environment.ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN: environment.ANTHROPIC_AUTH_TOKEN, ...(injectModel === null ? {} : { ANTHROPIC_MODEL: injectModel, ANTHROPIC_DEFAULT_SONNET_MODEL: injectModel, ANTHROPIC_DEFAULT_OPUS_MODEL: injectModel, ANTHROPIC_DEFAULT_HAIKU_MODEL: injectModel }), CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(route.contextLimit), CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1" } }));
      await chmod(settings, 0o600);
      if (hasMcp) {
        mcpConfig = join(claudeConfigDir, "mcp.json");
        await Bun.write(mcpConfig, JSON.stringify({ mcpServers: { personal_gateway: { type: "http", url: `${address}/mcp`, headers: { Authorization: "Bearer ${PGW_MCP_KEY}" } } } }));
        await chmod(mcpConfig, 0o600);
      }
      argv = [executable, ...(mcpConfig ? ["--mcp-config", mcpConfig] : []), "--settings", settings, ...(injectModel === null ? [] : ["--model", injectModel]), ...nativeArgs];
    } else {
      const configHome = join(home, "agents", "pi");
      await mkdir(configHome, { recursive: true, mode: 0o700 });
      environment.PI_CODING_AGENT_DIR = configHome;
      environment.PGW_MODEL_KEY = client.key;
      const piModel = injectModel ?? route.alias;
      const api = route.protocol === "messages" ? "anthropic-messages" : route.protocol === "responses" ? "openai-responses" : "openai-completions";
      await Bun.write(join(configHome, "models.json"), JSON.stringify({ providers: { pgw: { baseUrl: route.protocol === "messages" ? `${protocolBase(address, route.protocol)}/v1` : protocolBase(address, route.protocol), apiKey: "$PGW_MODEL_KEY", api, models: [{ id: piModel, name: piModel, contextWindow: route.contextLimit, maxTokens: route.outputLimit }] } } }));
      await chmod(join(configHome, "models.json"), 0o600);
      argv = [executable, "--provider", "pgw", "--model", piModel, ...nativeArgs];
    }
    const child = Bun.spawn(argv, { cwd: workspace, env: environment, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    try { process.exitCode = await child.exited; } finally { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); }
  } finally {
    if (claudeConfigDir) await rm(claudeConfigDir, { recursive: true, force: true });
    await context.request(`/clients/${client.id}`, "DELETE").catch((error) => process.stderr.write(`Credential cleanup: ${error.message}\n`));
  }
}

export async function startRun(context: CliContext, agent: "codex" | "claude" | "pi", options: Record<string, unknown>) {
  if (!options.goal) throw new Error("pgw run codex|claude|pi --goal TEXT [--model ALIAS] [--workspace PATH]");
  const coordinator = String(options.coordinator || "off");
  if (!["off", "suggest", "continue"].includes(coordinator)) throw new Error("--coordinator must be off|suggest|continue");
  await context.ensureServer();
  const routes = await context.request<ModelRoute[]>("/routes");
  const protocol = agent === "claude" ? ("messages" as const) : agent === "codex" ? ("responses" as const) : null;
  const pick = pickRoute(routes, protocol, options.model as string | undefined);
  if (!pick) throw new Error("No compatible route");
  if (pick.fallback && protocol) await noteConvertedRoute(context, pick.route, protocol);
  const timeout = String(options.timeout || "1800").match(/^(\d+)(s|m|h)?$/);
  if (!timeout) throw new Error("Invalid timeout");
  const timeoutSeconds = Number(timeout[1]) * (timeout[2] === "h" ? 3600 : timeout[2] === "m" ? 60 : 1);
  const result = await context.request("/runs", "POST", { agent, goal: options.goal, workspace: options.workspace || process.cwd(), routeId: pick.route.id, timeoutSeconds, controls: { mode: options.singleTurn ? "turn" : "goal", maxTurns: Number(options.maxTurns || 20), coordinatorMode: options.singleTurn ? "off" : coordinator, permission: options.permission || "read-only", budgetMicros: options.budgetUsd ? Math.round(Number(options.budgetUsd) * 1e6) : null, tokenLimit: options.tokenLimit ? Number(options.tokenLimit) : null, completionFiles: (options.completionFile as string[] | undefined || []).map((path) => ({ path })) } });
  writeValue(result, context.options, () => `Run started: ${String((result as { id?: string }).id || "created")}\nAgent: ${agent}\nGoal: ${String(options.goal)}`);
}
