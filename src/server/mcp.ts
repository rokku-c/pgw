import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  fromJsonSchema,
} from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { z } from "zod";
import {
  db,
  McpSchema,
  ClientSchema,
  AssetSchema,
  SessionSchema,
  PreferenceSchema,
  McpCallSchema,
  McpRevisionSchema,
  record,
  audit,
} from "./store";
import {
  decrypt,
  encrypt,
  hash,
  ApiError,
  requireAdmin,
  isAdmin,
  bearer,
} from "./security";
import { atomic } from "./transactions";
import { version, home, address, adminToken } from "./config";
import {
  cliQueryCommands,
  cliQueryPath,
  scopeCliQueryPath,
} from "../shared/cli-queries";
import {
  trajectoryNodes,
  trajectorySession,
  trajectorySessions,
} from "./trajectory-sessions";
import type {
  McpConnection,
  McpGrant,
  McpCall,
  ClientKey,
  PublicMcpCall,
} from "../shared/types";

type Principal = {
  id: string | null;
  name: string;
  project: string | null;
  sessionKey?: string | null;
  nativeSessionId?: string | null;
  nativeTurnId?: string | null;
  runId?: string | null;
  parentCallId?: string | null;
  evidence?: string | null;
};
const validators = new AjvJsonSchemaValidator();
const active = new Map<string, AbortController>();
const probeLocks = new Set<string>();
const schema = (value: unknown) => {
  const text = JSON.stringify(value);
  if (text.length > 200000) throw new ApiError(400, "schema_too_large");
  return value as any;
};
export const mcpAlias = (connectionId: string, name: string) =>
  `mcp_${connectionId.replaceAll("-", "").slice(0, 12)}_${name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 28)}_${hash(name).slice(0, 8)}`;
export const resourceAlias = (id: string, uri: string) =>
  `pgw://mcp/${id}/${Buffer.from(uri).toString("base64url")}`;
export function publicMcpCall(call: McpCall): PublicMcpCall {
  const { requestCipher, resultCipher, ...rest } = call;
  return rest;
}
async function connect(config: McpConnection, signal?: AbortSignal) {
  if (signal?.aborted) throw new ApiError(499, "call_cancelled");
  const client = new Client({ name: "personal-gateway", version });
  const transport =
    config.transport === "stdio"
      ? new StdioClientTransport({
          command: config.command!,
          args: config.args,
          cwd: home,
          env: config.envCipher ? JSON.parse(decrypt(config.envCipher)) : {},
          stderr: "ignore",
        })
      : new StreamableHTTPClientTransport(new URL(config.url!), {
          requestInit: {
            headers: config.headersCipher
              ? JSON.parse(decrypt(config.headersCipher))
              : {},
            redirect: "error",
          },
        });
  const abort = () => {
    void client.close().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await client.connect(transport, { timeout: 15000 });
    if (signal?.aborted) throw new ApiError(499, "call_cancelled");
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
async function catalog(client: Client, signal?: AbortSignal) {
  const capabilities = client.getServerCapabilities() || {};
  async function pages(kind: "tools" | "resources" | "prompts") {
    if (!(kind in capabilities)) return [];
    const entries: any[] = [],
      seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      if (signal?.aborted) throw new ApiError(499, "call_cancelled");
      const args = cursor ? { cursor } : {};
      const result: any =
        kind === "tools"
          ? await client.listTools(args, { timeout: 15000, signal })
          : kind === "resources"
            ? await client.listResources(args, { timeout: 15000, signal })
            : await client.listPrompts(args, { timeout: 15000, signal });
      if (
        !Array.isArray(result[kind]) ||
        entries.length + result[kind].length > 2000
      )
        throw new ApiError(502, "catalog_limit");
      entries.push(...result[kind]);
      cursor = result.nextCursor;
      if (!cursor) return entries;
      if (seen.has(cursor)) throw new ApiError(502, "catalog_cursor_cycle");
      seen.add(cursor);
    }
    throw new ApiError(502, "catalog_incomplete");
  }
  const tools = (await pages("tools"))
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: schema(t.inputSchema),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const resources = (await pages("resources"))
    .map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }))
    .sort((a, b) => a.uri.localeCompare(b.uri));
  const prompts = (await pages("prompts"))
    .map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (
    new Set(tools.map((t) => t.name)).size !== tools.length ||
    new Set(resources.map((r) => r.uri)).size !== resources.length ||
    new Set(prompts.map((p) => p.name)).size !== prompts.length
  )
    throw new ApiError(502, "catalog_duplicate_names");
  for (const tool of tools) validators.getValidator(schema(tool.inputSchema));
  return { tools, resources, prompts };
}
export async function probeMcp(config: McpConnection) {
  if (probeLocks.has(config.id)) throw new ApiError(409, "probe_in_progress");
  probeLocks.add(config.id);
  let client: Client | undefined;
  try {
    if (!config.enabled) throw new ApiError(409, "mcp_disabled");
    client = await connect(config);
    const next = await catalog(client, AbortSignal.timeout(60000));
    const schemaHash = hash(JSON.stringify(next));
    const update = {
      ...next,
      version: client.getServerVersion()?.version || null,
      capabilities:
        (client.getServerCapabilities() as Record<string, unknown>) || {},
      status: "up" as const,
      previousSchemaHash:
        config.schemaHash && config.schemaHash !== schemaHash
          ? config.schemaHash
          : config.previousSchemaHash,
      schemaHash,
      lastChecked: Date.now(),
      lastError: null,
      updatedAt: Date.now(),
    };
    await atomic((database) => {
      if (
        !database
          .query("SELECT id FROM mcp_connections WHERE id=?")
          .get(config.id)
      )
        throw new ApiError(404, "mcp_not_found");
      database
        .query(
          "UPDATE mcp_connections SET tools=?,resources=?,prompts=?,version=?,capabilities=?,status='up',previousSchemaHash=?,schemaHash=?,lastChecked=?,lastError=NULL,updatedAt=? WHERE id=?",
        )
        .run(
          JSON.stringify(next.tools),
          JSON.stringify(next.resources),
          JSON.stringify(next.prompts),
          update.version,
          JSON.stringify(update.capabilities),
          update.previousSchemaHash,
          schemaHash,
          update.lastChecked,
          update.updatedAt,
          config.id,
        );
      if (config.schemaHash !== schemaHash) {
        const entry = record();
        database
          .query(
            "INSERT INTO mcp_revisions(id,createdAt,updatedAt,connectionId,hash,version,catalog) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            entry.id,
            entry.createdAt,
            entry.updatedAt,
            config.id,
            schemaHash,
            update.version,
            JSON.stringify(next),
          );
      }
    });
    await audit("mcp.probed", config.id, {
      tools: next.tools.length,
      resources: next.resources.length,
      prompts: next.prompts.length,
      schemaHash,
    });
    return update;
  } catch (error) {
    const update = {
      status: "down" as const,
      lastChecked: Date.now(),
      lastError: error instanceof ApiError ? error.code : "connection_failed",
      updatedAt: Date.now(),
    };
    await db.getRepository(McpSchema).update(config.id, update);
    await audit("mcp.probe_failed", config.id);
    return update;
  } finally {
    probeLocks.delete(config.id);
    await client?.close().catch(() => {});
  }
}
export async function validateGrants(grants: McpGrant[]) {
  if (new Set(grants.map((g) => g.connectionId)).size !== grants.length)
    throw new ApiError(400, "duplicate_mcp_grant");
  for (const grant of grants) {
    const config = await db
      .getRepository(McpSchema)
      .findOneBy({ id: grant.connectionId, enabled: true });
    if (!config || config.schemaHash !== grant.schemaHash)
      throw new ApiError(409, "catalog_changed");
    if (
      grant.tools.some((name) => !config.tools.some((t) => t.name === name)) ||
      grant.resources.some(
        (uri) => !config.resources.some((r) => r.uri === uri),
      ) ||
      grant.prompts.some((name) => !config.prompts.some((p) => p.name === name))
    )
      throw new ApiError(400, "unknown_mcp_capability");
  }
}
async function currentGrant(
  principal: Principal,
  config: McpConnection,
  kind: McpCall["kind"],
  name: string,
) {
  const current = await db
    .getRepository(McpSchema)
    .findOneBy({ id: config.id, enabled: true });
  if (!current) throw new ApiError(409, "mcp_disabled");
  if (current.schemaHash !== config.schemaHash)
    throw new ApiError(409, "catalog_changed");
  if (!principal.id) return { requireApproval: false };
  const client = await db
    .getRepository(ClientSchema)
    .findOneBy({ id: principal.id, enabled: true });
  if (!client || (client.expiresAt !== null && client.expiresAt <= Date.now()))
    throw new ApiError(401, "key_revoked");
  const grant = client.mcpGrants.find(
    (g) => g.connectionId === config.id && g.schemaHash === config.schemaHash,
  );
  const allowed =
    kind === "tool"
      ? grant?.tools
      : kind === "resource"
        ? grant?.resources
        : grant?.prompts;
  if (!grant || !allowed?.includes(name))
    throw new ApiError(403, "mcp_scope_denied");
  return grant;
}
function validateInput(
  config: McpConnection,
  kind: McpCall["kind"],
  name: string,
  args: Record<string, unknown>,
) {
  if (Buffer.byteLength(JSON.stringify(args)) > 1024 * 1024)
    throw new ApiError(413, "tool_input_too_large");
  if (kind === "tool") {
    const tool = config.tools.find((t) => t.name === name);
    if (!tool) throw new ApiError(404, "tool_not_found");
    const result = validators.getValidator(schema(tool.inputSchema))(args);
    if (!result.valid) throw new ApiError(400, "invalid_tool_arguments");
  } else if (kind === "prompt") {
    const prompt = config.prompts.find((p) => p.name === name);
    if (!prompt) throw new ApiError(404, "prompt_not_found");
    const parameters = prompt.arguments || [];
    if (
      parameters.some((p) => p.required && typeof args[p.name] !== "string") ||
      Object.entries(args).some(
        ([key, value]) =>
          typeof value !== "string" || !parameters.some((p) => p.name === key),
      )
    )
      throw new ApiError(400, "invalid_prompt_arguments");
  } else if (!config.resources.some((r) => r.uri === name))
    throw new ApiError(404, "resource_not_found");
}
const sleeping = (signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new ApiError(499, "call_cancelled"));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new ApiError(499, "call_cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 300);
    signal.addEventListener("abort", abort, { once: true });
  });
export async function executeMcp(
  config: McpConnection,
  kind: McpCall["kind"],
  name: string,
  args: Record<string, unknown>,
  principal: Principal,
  requestSignal: AbortSignal,
  confirmed = false,
): Promise<any> {
  validateInput(config, kind, name, args);
  const grant = await currentGrant(principal, config, kind, name);
  const call: McpCall = {
    ...record(),
    connectionId: config.id,
    connectionName: config.name,
    clientId: principal.id,
    clientName: principal.name,
    project: principal.project,
    kind,
    name,
    schemaHash: config.schemaHash!,
    requestCipher: encrypt(JSON.stringify(args)),
    sessionKey: principal.sessionKey || null,
    nativeSessionId: principal.nativeSessionId || null,
    nativeTurnId: principal.nativeTurnId || null,
    runId: principal.runId || null,
    parentCallId: principal.parentCallId || null,
    evidence: principal.evidence || null,
    status: grant.requireApproval && !confirmed ? "pending" : "approved",
    resultCipher: null,
    error: null,
    expiresAt: Date.now() + 120000,
    startedAt: null,
    endedAt: null,
  };
  await atomic((database) => {
    const count = database
      .query(
        "SELECT count(*) n FROM mcp_calls WHERE status IN ('pending','approved','running')",
      )
      .get() as { n: number };
    const personal = principal.id
      ? (database
          .query(
            "SELECT count(*) n FROM mcp_calls WHERE clientId=? AND status IN ('pending','approved','running')",
          )
          .get(principal.id) as { n: number })
      : count;
    if (count.n >= 32 || (principal.id && personal.n >= 4))
      throw new ApiError(429, "mcp_concurrency_limit");
    database
      .query(
        "INSERT INTO mcp_calls(id,createdAt,updatedAt,connectionId,connectionName,clientId,clientName,project,kind,name,schemaHash,requestCipher,sessionKey,nativeSessionId,nativeTurnId,runId,parentCallId,evidence,status,resultCipher,error,expiresAt,startedAt,endedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,NULL,NULL)",
      )
      .run(
        call.id,
        call.createdAt,
        call.updatedAt,
        call.connectionId,
        call.connectionName,
        call.clientId,
        call.clientName,
        call.project,
        call.kind,
        call.name,
        call.schemaHash,
        call.requestCipher,
        call.sessionKey,
        call.nativeSessionId,
        call.nativeTurnId,
        call.runId,
        call.parentCallId,
        call.evidence,
        call.status,
        call.expiresAt,
      );
  });
  const controller = new AbortController();
  active.set(call.id, controller);
  const signal = AbortSignal.any([
    controller.signal,
    requestSignal,
    AbortSignal.timeout(180000),
  ]);
  let client: Client | undefined,
    submitted = false;
  try {
    while (true) {
      if (signal.aborted) throw new ApiError(499, "call_cancelled");
      await currentGrant(principal, config, kind, name);
      const current = await db
        .getRepository(McpCallSchema)
        .findOneBy({ id: call.id });
      if (!current || ["cancelled", "rejected"].includes(current.status))
        throw new ApiError(
          403,
          current?.status === "rejected" ? "tool_rejected" : "call_cancelled",
        );
      if (Date.now() >= call.expiresAt)
        throw new ApiError(408, "approval_expired");
      if (current.status === "approved") break;
      await sleeping(signal);
    }
    client = await connect(config, signal);
    const actual = await catalog(client, signal);
    if (signal.aborted) throw new ApiError(499, "call_cancelled");
    if (hash(JSON.stringify(actual)) !== config.schemaHash)
      throw new ApiError(409, "upstream_catalog_changed");
    await currentGrant(principal, config, kind, name);
    if (signal.aborted) throw new ApiError(499, "call_cancelled");
    const started = await db
      .getRepository(McpCallSchema)
      .createQueryBuilder()
      .update()
      .set({ status: "running", startedAt: Date.now(), updatedAt: Date.now() })
      .where("id = :id AND status = 'approved'", { id: call.id })
      .execute();
    if (!started.affected) throw new ApiError(409, "call_not_approved");
    if (signal.aborted) throw new ApiError(499, "call_cancelled");
    const monitor = setInterval(() => {
      void currentGrant(principal, config, kind, name).catch(() =>
        controller.abort(),
      );
    }, 1000);
    let result: any;
    try {
      submitted = true;
      result =
        kind === "tool"
          ? await client.callTool(
              { name, arguments: args },
              { timeout: 60000, signal },
            )
          : kind === "resource"
            ? await client.readResource(
                { uri: name },
                { timeout: 60000, signal },
              )
            : await client.getPrompt(
                { name, arguments: args as Record<string, string> },
                { timeout: 60000, signal },
              );
    } finally {
      clearInterval(monitor);
    }
    if (signal.aborted) throw new ApiError(499, "call_cancelled");
    const serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized) > 8 * 1024 * 1024)
      throw new ApiError(502, "tool_result_too_large");
    await db.getRepository(McpCallSchema).update(call.id, {
      status: result.isError ? "failed" : "completed",
      resultCipher: encrypt(serialized),
      error: result.isError ? "upstream_tool_error" : null,
      endedAt: Date.now(),
      updatedAt: Date.now(),
    });
    await audit(
      result.isError ? "mcp.call_failed" : "mcp.call_completed",
      call.id,
      { connectionId: config.id, kind, name, isError: result.isError === true },
    );
    return result;
  } catch (error) {
    const code =
      error instanceof ApiError
        ? error.code
        : signal.aborted
          ? "call_cancelled"
          : "upstream_call_failed";
    const status = submitted
      ? "uncertain"
      : code === "tool_rejected"
        ? "rejected"
        : code === "call_cancelled" || code === "approval_expired"
          ? "cancelled"
          : "failed";
    await db.getRepository(McpCallSchema).update(call.id, {
      status,
      error: code,
      endedAt: Date.now(),
      updatedAt: Date.now(),
    });
    await audit(`mcp.call_${status}`, call.id, { code });
    throw error instanceof ApiError ? error : new ApiError(502, code);
  } finally {
    try {
      await client?.close().catch(() => {});
    } finally {
      active.delete(call.id);
    }
  }
}
export async function decideMcpCall(id: string, accept: boolean) {
  await atomic((database) => {
    const call = database
      .query("SELECT status,expiresAt FROM mcp_calls WHERE id=?")
      .get(id) as McpCall | null;
    if (
      !call ||
      call.status !== "pending" ||
      call.expiresAt <= Date.now() ||
      !active.has(id)
    )
      throw new ApiError(409, "approval_expired");
    database
      .query(
        "UPDATE mcp_calls SET status=?,updatedAt=? WHERE id=? AND status='pending'",
      )
      .run(accept ? "approved" : "rejected", Date.now(), id);
  });
  await audit("mcp.approval_decided", id, { accept });
  return { ok: true };
}
export async function cancelMcpCall(id: string) {
  const controller = active.get(id);
  if (!controller) throw new ApiError(409, "call_not_active");
  await db
    .getRepository(McpCallSchema)
    .createQueryBuilder()
    .update()
    .set({ status: "cancelled", updatedAt: Date.now() })
    .where("id=:id AND status IN ('pending','approved')", { id })
    .execute();
  controller.abort();
  await audit("mcp.cancel_requested", id);
  return { ok: true };
}
export async function callMcp(
  config: McpConnection,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) {
  return executeMcp(
    config,
    "tool",
    name,
    args,
    { id: null, name: "Console", project: null },
    signal,
    true,
  );
}
export async function stopMcpCalls() {
  for (const controller of active.values()) controller.abort();
  while (active.size) await Bun.sleep(25);
}
const gatewayResources = [
  ["status", [], "pgw://gateway/status", "Gateway status"],
  ["sources", [], "pgw://gateway/sources", "Session sources"],
  ["sessions", [], "pgw://gateway/sessions", "Session index"],
  ["persona", [], "pgw://gateway/persona", "Confirmed preferences"],
  ["skills", [], "pgw://gateway/skills", "Installed skills"],
  ["asset-roots", [], "pgw://gateway/asset-roots", "Skill asset roots"],
  ["asset-installs", [], "pgw://gateway/asset-installs", "Skill installations"],
  ["jobs", [], "pgw://gateway/jobs", "Background jobs"],
  ["mcp", [], "pgw://gateway/mcp", "MCP connections"],
  ["mcp", ["calls"], "pgw://gateway/mcp-calls", "MCP calls"],
  ["export", [], "pgw://gateway/export", "Gateway inventory export"],
] as const;

async function localCliQuery(
  path: string,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(`${address}/api${path}`, {
    headers: { authorization: `Bearer ${adminToken}` },
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  const result = (await response.json()) as any;
  if (!response.ok)
    throw new ApiError(response.status, result.error?.code || "query_failed");
  if (response.status === 202 && result.job) {
    for (;;) {
      await Bun.sleep(200);
      const job = (await localCliQuery(
        `/jobs/${result.job.id}`,
        signal,
      )) as any;
      if (job.status === "completed") return job.result;
      if (["failed", "cancelled", "uncertain"].includes(job.status))
        throw new ApiError(502, job.error || job.status);
    }
  }
  return result;
}

async function runCliQuery(
  command: string,
  args: string[],
  client: ClientKey | null,
  signal: AbortSignal,
) {
  if (client && command !== "status" && !client.memoryAccess)
    throw new ApiError(403, "mcp_scope_denied");
  const path = scopeCliQueryPath(cliQueryPath(command, args), client?.project);
  return localCliQuery(path, signal);
}

const trajectoryKey = z
  .string()
  .regex(/^(scanned|managed|external|route|call):[a-zA-Z0-9-]{1,100}$/);

function requireMemoryAccess(client: ClientKey | null) {
  if (client && !client.memoryAccess)
    throw new ApiError(403, "mcp_scope_denied");
}

function requireProject(
  client: ClientKey | null,
  project: string | null | undefined,
) {
  if (client?.project && project !== client.project)
    throw new ApiError(403, "project_scope_denied");
}

async function scopedTrajectorySessions(
  input: Parameters<typeof trajectorySessions>[0],
  client: ClientKey | null,
) {
  const limit = Math.min(input.limit || 20, 50);
  let cursor = input.cursor;
  let next: string | null = null;
  const items = [];
  for (let page = 0; page < 20 && items.length < limit; page++) {
    const result = await trajectorySessions({
      ...input,
      cursor,
      limit: Math.min(100, Math.max(limit * 2, 40)),
    });
    const visible = client?.project
      ? result.items.filter((item) => item.project === client.project)
      : result.items;
    items.push(...visible.slice(0, limit - items.length));
    next = result.next;
    if (!result.next) break;
    cursor = result.next;
  }
  return { items, next };
}

async function visibleTrajectorySession(key: string, client: ClientKey | null) {
  const session = trajectorySession(key);
  requireProject(client, session.project);
  return session;
}

function trajectoryEnvelope(
  session: Awaited<ReturnType<typeof trajectorySession>>,
  page: Awaited<ReturnType<typeof trajectoryNodes>>,
) {
  return {
    sourceId: `trajectory:${session.key}`,
    observedAt: session.at,
    generatedAt: Date.now(),
    coverage: {
      status: page.next === null ? "complete" : "partial",
      evidence: session.evidence,
      total: page.total,
      revision: page.revision,
    },
  };
}

async function authenticatedClient(request: Request) {
  if (isAdmin(request)) {
    requireAdmin(request);
    return null;
  }
  const key = bearer(request);
  const client = key
    ? await db
        .getRepository(ClientSchema)
        .findOneBy({ keyHash: hash(key), enabled: true })
    : null;
  if (!client || (client.expiresAt !== null && client.expiresAt <= Date.now()))
    throw new ApiError(401, "invalid_api_key");
  if (!client.memoryAccess && !client.mcpGrants.length)
    throw new ApiError(403, "mcp_scope_denied");
  return client;
}
export async function handleMcp(request: Request) {
  const client = await authenticatedClient(request);
  const nativeSessionId =
    request.headers.get("x-claude-code-session-id") ||
    request.headers.get("x-codex-session-id") ||
    request.headers.get("x-session-id");
  const nativeTurnId =
    request.headers.get("x-pgw-turn-id") ||
    request.headers.get("x-codex-turn-id");
  const rawSession = request.headers.get("x-pgw-session") || nativeSessionId;
  const sessionKey = rawSession
    ? `external:${hash(`${client?.id || "admin"}:${rawSession}:${client?.project || ""}`)}`
    : null;
  const principal: Principal = client
    ? {
        id: client.id,
        name: client.name,
        project: client.project,
        sessionKey,
        nativeSessionId,
        nativeTurnId,
        runId: client.runId,
        parentCallId: request.headers.get("x-pgw-attempt-id"),
        evidence: request.headers.get("x-pgw-attempt-id")
          ? "model_call_header"
          : nativeSessionId
            ? "native_session_header"
            : null,
      }
    : {
        id: null,
        name: "Admin MCP",
        project: null,
        sessionKey,
        nativeSessionId,
        nativeTurnId,
        parentCallId: request.headers.get("x-pgw-attempt-id"),
        evidence: "admin_request",
      };
  const server = new McpServer(
    { name: "personal-gateway", version },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );
  const exposed = {
    tools: 1 + (!client || client.memoryAccess ? 7 : 0),
    resources: client && !client.memoryAccess ? 1 : gatewayResources.length,
    prompts: 0,
  };
  const reauthorize = async () => {
    const next = await authenticatedClient(request);
    if (client && next?.id !== client.id)
      throw new ApiError(403, "mcp_scope_denied");
    return next;
  };
  server.registerTool(
    "gateway_cli",
    {
      title: "Gateway CLI query",
      description:
        "Run a read-only pgw query. Commands match the query-capable CLI commands.",
      inputSchema: z.object({
        command: z.enum(cliQueryCommands),
        args: z.array(z.string().max(2000)).max(20).default([]),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ command, args }, context) => {
      const fresh = await reauthorize();
      const result = await runCliQuery(
        command,
        args,
        fresh,
        context.mcpReq.signal,
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );
  for (const [command, args, uri, description] of gatewayResources) {
    if (client && !client.memoryAccess && command !== "status") continue;
    server.registerResource(
      `gateway_${uri.split("/").at(-1)}`,
      uri,
      { description, mimeType: "application/json" },
      async (url, context) => {
        const fresh = await reauthorize();
        const result = await runCliQuery(
          command,
          [...args],
          fresh,
          context.mcpReq.signal,
        );
        return {
          contents: [
            {
              uri: url.href,
              mimeType: "application/json",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      },
    );
  }
  if (!client || client.memoryAccess) {
    server.registerTool(
      "gateway_session_context",
      {
        title: "Gateway session context",
        description:
          "Read-only session index and recent trajectory context within the authorized project.",
        inputSchema: z.object({
          sessionKey: trajectoryKey.optional(),
          query: z.string().max(300).default(""),
          kind: z.enum(["scanned", "managed", "independent"]).optional(),
          cursor: z.string().max(3000).optional(),
          limit: z.number().int().min(1).max(50).default(20),
        }),
        annotations: { readOnlyHint: true },
      },
      async ({ sessionKey, query, kind, cursor, limit }) => {
        const fresh = await reauthorize();
        requireMemoryAccess(fresh);
        if (sessionKey) {
          const session = await visibleTrajectorySession(sessionKey, fresh);
          const page = await trajectoryNodes({
            key: session.key,
            offset: 0,
            limit,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ...trajectoryEnvelope(session, page),
                  session,
                  recent: page.items,
                }),
              },
            ],
          };
        }
        const result = await scopedTrajectorySessions(
          { query, kind, cursor, limit },
          fresh,
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                sourceId: "trajectory:index",
                generatedAt: Date.now(),
                coverage: {
                  status: result.next ? "partial" : "complete",
                  project: fresh?.project || null,
                },
                ...result,
              }),
            },
          ],
        };
      },
    );

    server.registerTool(
      "gateway_project_context",
      {
        title: "Gateway project context",
        description:
          "Read-only recent sessions and work activity for the authorized project.",
        inputSchema: z.object({
          query: z.string().max(300).default(""),
          cursor: z.string().max(3000).optional(),
          limit: z.number().int().min(1).max(50).default(20),
        }),
        annotations: { readOnlyHint: true },
      },
      async ({ query, cursor, limit }) => {
        const fresh = await reauthorize();
        requireMemoryAccess(fresh);
        const result = await scopedTrajectorySessions(
          { query, cursor, limit },
          fresh,
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                sourceId: "trajectory:project",
                generatedAt: Date.now(),
                coverage: {
                  status: result.next ? "partial" : "complete",
                  project: fresh?.project || null,
                },
                ...result,
              }),
            },
          ],
        };
      },
    );

    server.registerTool(
      "gateway_trajectory",
      {
        title: "Gateway trajectory",
        description:
          "Read-only paged trajectory nodes for an authorized session.",
        inputSchema: z.object({
          sessionKey: trajectoryKey,
          offset: z.number().int().min(0).max(10_000_000).default(0),
          limit: z.number().int().min(1).max(50).default(20),
          revision: z.string().max(500).optional(),
        }),
        annotations: { readOnlyHint: true },
      },
      async ({ sessionKey, offset, limit, revision }) => {
        const fresh = await reauthorize();
        requireMemoryAccess(fresh);
        const session = await visibleTrajectorySession(sessionKey, fresh);
        const page = await trajectoryNodes({
          key: session.key,
          offset,
          limit,
          revision,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ...trajectoryEnvelope(session, page),
                ...page,
              }),
            },
          ],
        };
      },
    );

    server.registerTool(
      "gateway_handoff",
      {
        title: "Gateway handoff context",
        description:
          "Build a read-only, recent-context handoff packet. It does not steer, resume, stop, or mutate a session.",
        inputSchema: z.object({
          sessionKey: trajectoryKey,
          limit: z.number().int().min(1).max(50).default(20),
        }),
        annotations: { readOnlyHint: true },
      },
      async ({ sessionKey, limit }) => {
        const fresh = await reauthorize();
        requireMemoryAccess(fresh);
        const session = await visibleTrajectorySession(sessionKey, fresh);
        const head = await trajectoryNodes({
          key: session.key,
          offset: 0,
          limit: 1,
        });
        const offset = Math.max(0, head.total - limit);
        const page = offset
          ? await trajectoryNodes({
              key: session.key,
              offset,
              limit,
              revision: head.revision,
            })
          : head;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                sourceId: `handoff:${session.key}`,
                generatedAt: Date.now(),
                observedAt: session.at,
                readOnly: true,
                coverage: {
                  status:
                    offset === 0 && page.next === null ? "complete" : "partial",
                  evidence: session.evidence,
                  total: page.total,
                  included: page.items.length,
                  revision: page.revision,
                },
                session,
                recent: page.items,
              }),
            },
          ],
        };
      },
    );

    server.registerTool(
      "gateway_inventory",
      {
        title: "Gateway inventory",
        inputSchema: z.object({
          kind: z.enum(["agent", "skill", "mcp"]).optional(),
        }),
        annotations: { readOnlyHint: true },
      },
      async ({ kind }) => {
        const fresh = await reauthorize();
        if (fresh && !fresh.memoryAccess)
          throw new ApiError(403, "mcp_scope_denied");
        const items = await db
          .getRepository(AssetSchema)
          .find({ where: kind ? { kind } : {}, take: 300 });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                items.map(({ name, kind, source, version, status }) => ({
                  name,
                  kind,
                  source,
                  version,
                  status,
                })),
              ),
            },
          ],
        };
      },
    );
    server.registerTool(
      "gateway_sessions",
      {
        title: "Session index",
        inputSchema: z.object({ query: z.string().max(200).default("") }),
        annotations: { readOnlyHint: true },
      },
      async ({ query }) => {
        const fresh = await reauthorize();
        if (fresh && !fresh.memoryAccess)
          throw new ApiError(403, "mcp_scope_denied");
        const items = await db.getRepository(SessionSchema).find({
          where: fresh?.project ? { project: fresh.project } : {},
          order: { lastActiveAt: "DESC" },
          take: 300,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                items
                  .filter((s) =>
                    `${s.title} ${s.project}`
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                  )
                  .slice(0, 50)
                  .map(({ id, title, agent, project, lastActiveAt }) => ({
                    id,
                    title,
                    agent,
                    project,
                    lastActiveAt,
                  })),
              ),
            },
          ],
        };
      },
    );
    server.registerTool(
      "gateway_preferences",
      {
        title: "Confirmed preferences",
        inputSchema: z.object({ project: z.string().max(1000).optional() }),
        annotations: { readOnlyHint: true },
      },
      async ({ project }) => {
        const fresh = await reauthorize();
        if (fresh && !fresh.memoryAccess)
          throw new ApiError(403, "mcp_scope_denied");
        if (fresh?.project && project && project !== fresh.project)
          throw new ApiError(403, "project_scope_denied");
        const scope = fresh?.project || project;
        const prefs = await db
          .getRepository(PreferenceSchema)
          .findBy({ status: "active" });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                prefs.filter(
                  (p) => p.scope === "global" || p.project === scope,
                ),
              ),
            },
          ],
        };
      },
    );
  }
  const connections = await db
    .getRepository(McpSchema)
    .findBy({ enabled: true });
  for (const connection of connections) {
    const grant = client?.mcpGrants.find(
      (g) =>
        g.connectionId === connection.id &&
        g.schemaHash === connection.schemaHash,
    );
    if ((client && !grant) || !connection.schemaHash) continue;
    exposed.tools += connection.tools.filter(
      (t) => !client || grant?.tools.includes(t.name),
    ).length;
    exposed.resources += connection.resources.filter(
      (r) => !client || grant?.resources.includes(r.uri),
    ).length;
    exposed.prompts += connection.prompts.filter(
      (p) => !client || grant?.prompts.includes(p.name),
    ).length;
    const call = (
      kind: McpCall["kind"],
      name: string,
      args: Record<string, unknown>,
      signal: AbortSignal,
    ) =>
      executeMcp(
        connection,
        kind,
        name,
        args,
        principal,
        AbortSignal.any([signal, request.signal]),
      );
    for (const tool of connection.tools.filter(
      (t) => !client || grant?.tools.includes(t.name),
    ))
      server.registerTool(
        mcpAlias(connection.id, tool.name),
        {
          title: `${connection.name} / ${tool.name}`,
          description: tool.description,
          inputSchema: fromJsonSchema<Record<string, unknown>>(
            schema(tool.inputSchema),
          ),
        },
        async (args, context) => {
          try {
            return await call("tool", tool.name, args, context.mcpReq.signal);
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text:
                    error instanceof ApiError
                      ? error.code
                      : "upstream_call_failed",
                },
              ],
            };
          }
        },
      );
    for (const resource of connection.resources.filter(
      (r) => !client || grant?.resources.includes(r.uri),
    )) {
      const uri = resourceAlias(connection.id, resource.uri);
      server.registerResource(
        mcpAlias(connection.id, resource.uri),
        uri,
        { description: resource.description, mimeType: resource.mimeType },
        async (_url, context) => {
          const result = await call(
            "resource",
            resource.uri,
            {},
            context.mcpReq.signal,
          );
          return {
            ...result,
            contents: result.contents.map((content: any) => ({
              ...content,
              uri: resourceAlias(connection.id, content.uri),
            })),
          };
        },
      );
    }
    for (const prompt of connection.prompts.filter(
      (p) => !client || grant?.prompts.includes(p.name),
    )) {
      const args = Object.fromEntries(
        (prompt.arguments || []).map((p) => [
          p.name,
          p.required ? z.string() : z.string().optional(),
        ]),
      );
      server.registerPrompt(
        mcpAlias(connection.id, prompt.name),
        { description: prompt.description, argsSchema: z.object(args) },
        async (args, context) =>
          call("prompt", prompt.name, args, context.mcpReq.signal),
      );
    }
  }
  server.server.setRequestHandler("resources/templates/list", async () => ({
    resourceTemplates: [],
  }));
  if (!exposed.tools)
    server.server.setRequestHandler("tools/list", async () => ({ tools: [] }));
  if (!exposed.resources)
    server.server.setRequestHandler("resources/list", async () => ({
      resources: [],
    }));
  if (!exposed.prompts)
    server.server.setRequestHandler("prompts/list", async () => ({
      prompts: [],
    }));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
export async function revokeMcpAccess(scope: {
  clientId?: string;
  connectionId?: string;
}) {
  const query = db
    .getRepository(McpCallSchema)
    .createQueryBuilder("c")
    .where("c.status IN ('pending','approved','running')");
  if (scope.clientId)
    query.andWhere("c.clientId=:clientId", { clientId: scope.clientId });
  if (scope.connectionId)
    query.andWhere("c.connectionId=:connectionId", {
      connectionId: scope.connectionId,
    });
  for (const call of await query.getMany()) {
    await db
      .getRepository(McpCallSchema)
      .createQueryBuilder()
      .update()
      .set({
        status: "cancelled",
        error: "access_revoked",
        updatedAt: Date.now(),
      })
      .where("id=:id AND status IN ('pending','approved')", { id: call.id })
      .execute();
    active.get(call.id)?.abort();
  }
}
