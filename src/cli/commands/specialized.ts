import { ensureConfirm, writeApiResult } from "./control";
import type { CliContext } from "../types";

type Options = Record<string, unknown>;

function jsonBody(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Invalid JSON passed to --body or --arguments");
  }
}

function query(options: Options, names: string[]) {
  const params = new URLSearchParams();
  for (const name of names) {
    const value = options[name];
    if (value !== undefined && value !== "") params.set(name, String(value));
  }
  return params.toString();
}

function idPath(id: string) {
  return encodeURIComponent(id);
}

function bodyFrom(options: Options, fallback: Record<string, unknown> = {}) {
  const body = jsonBody(options.body);
  return body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : fallback;
}

export async function sourceSpecial(context: CliContext, action: "remove" | "restore", id: string, options: Options = {}) {
  if (!id) throw new Error(`pgw source ${action} SOURCE_ID`);
  await context.ensureServer();
  await ensureConfirm(Boolean(options.confirm), `pgw source ${action} ${id}`);
  const path = `/sources/${idPath(id)}${action === "restore" ? "/restore-deleted" : ""}`;
  await writeApiResult(context, await context.request(path, action === "remove" ? "DELETE" : "POST"), action === "remove" ? "Source removed" : "Source restored");
}

export async function sourceEdit(context: CliContext, id: string, options: Options) {
  if (!id) throw new Error("pgw source edit SOURCE_ID --body JSON --confirm");
  await ensureConfirm(Boolean(options.confirm), `pgw source edit ${id}`);
  await context.ensureServer();
  await writeApiResult(context, await context.request(`/sources/${idPath(id)}`, "PATCH", bodyFrom(options)), "Source updated");
}

export async function assetRootsCommand(context: CliContext, action: "list" | "create" | "patch" | "scan" | "delete", id: string | undefined, options: Options) {
  await context.ensureServer();
  if (action === "list") {
    await writeApiResult(context, await context.request("/asset-roots"), "Asset roots");
    return;
  }
  if (action === "scan") {
    if (!id) throw new Error("pgw asset-roots scan ROOT_ID");
    await writeApiResult(context, await context.request(`/asset-roots/${idPath(id)}/scan`, "POST"), "Asset root scan");
    return;
  }
  if (action === "delete") {
    throw new Error("The server API has no asset-root delete route; use `asset-roots patch ROOT_ID --body '{\"enabled\":false}' --confirm`.");
  }
  await ensureConfirm(Boolean(options.confirm), `pgw asset-roots ${action}${id ? ` ${id}` : ""}`);
  const fallback = {
    name: options.name,
    agent: options.agent || "shared",
    path: options.path,
    project: options.project ?? null,
    enabled: options.enabled !== undefined ? Boolean(options.enabled) : true,
    followSymlinks: Boolean(options.followSymlinks),
    capture: Boolean(options.capture),
    ...(options.revision ? { revision: Number(options.revision) } : {}),
  };
  const body = bodyFrom(options, fallback);
  if (action === "create" && (!body.name || !body.path)) throw new Error("Asset root create requires --body JSON with name and path");
  if (action === "patch" && !id) throw new Error("pgw asset-roots patch ROOT_ID --body JSON --confirm");
  const path = action === "create" ? "/asset-roots" : `/asset-roots/${idPath(id as string)}`;
  await writeApiResult(context, await context.request(path, action === "create" ? "POST" : "PATCH", body), action === "create" ? "Asset root created" : "Asset root updated");
}

export async function skillsCommand(context: CliContext, options: Options) {
  await context.ensureServer();
  const params = query(options, ["query", "offset", "limit", "rootId", "duplicates"]);
  await writeApiResult(context, await context.request(`/skills${params ? `?${params}` : ""}`), "Skills");
}

export async function assetCommand(context: CliContext, action: "list" | "inspect" | "snapshot" | "preview" | "deployments" | "apply" | "restore", id: string | undefined, options: Options) {
  await context.ensureServer();
  if (action === "list") return writeApiResult(context, await context.request("/assets"), "Assets");
  if (action === "deployments") return writeApiResult(context, await context.request("/asset-deployments"), "Asset deployments");
  if (!id) throw new Error(`pgw assets ${action} ASSET_ID`);
  if (action === "inspect") return writeApiResult(context, await context.request(`/assets/${idPath(id)}`), "Asset detail");
  if (action === "snapshot") {
    await ensureConfirm(Boolean(options.confirm), `pgw assets snapshot ${id}`);
    return writeApiResult(context, await context.request(`/assets/${idPath(id)}/snapshot`, "POST", { confirmed: true }), "Asset snapshot");
  }
  if (action === "preview") {
    const body = bodyFrom(options, { snapshotId: options.snapshot, targetRoot: options.target, name: options.name, agent: options.agent || "shared" });
    if (!body.snapshotId || !body.targetRoot || !body.name) throw new Error("Asset preview requires --snapshot ID --target DIRECTORY --name NAME");
    return writeApiResult(context, await context.request(`/assets/${idPath(id)}/deploy`, "POST", body), "Asset deployment preview");
  }
  await ensureConfirm(Boolean(options.confirm), `pgw assets ${action} ${id}`);
  return writeApiResult(context, await context.request(`/asset-deployments/${idPath(id)}/${action}`, "POST", { confirmed: true }), `Asset ${action}`);
}

export async function mcpConnectionCommand(context: CliContext, action: "list" | "catalog" | "create" | "patch" | "delete" | "probe" | "history" | "tool" | "call" | "resource" | "prompt", id: string | undefined, options: Options) {
  await context.ensureServer();
  if (action === "list" || action === "catalog") return writeApiResult(context, await context.request("/mcp"), action === "catalog" ? "MCP catalog" : "MCP connections");
  if (action === "create") {
    await ensureConfirm(Boolean(options.confirm), "pgw mcp create");
    return writeApiResult(context, await context.request("/mcp", "POST", bodyFrom(options)), "MCP connection created");
  }
  if (!id) throw new Error(`pgw mcp ${action} CONNECTION_ID`);
  const encodedId = idPath(id);
  if (action === "patch") {
    await ensureConfirm(Boolean(options.confirm), `pgw mcp patch ${id}`);
    const body = bodyFrom(options, { enabled: options.enabled === true });
    if (body.enabled === undefined) throw new Error("MCP patch requires --body '{\"enabled\":true}'");
    return writeApiResult(context, await context.request(`/mcp/${encodedId}`, "PATCH", body), "MCP connection updated");
  }
  if (action === "delete") {
    await ensureConfirm(Boolean(options.confirm), `pgw mcp delete ${id}`);
    return writeApiResult(context, await context.request(`/mcp/${encodedId}`, "DELETE"), "MCP connection deleted");
  }
  if (action === "probe") return writeApiResult(context, await context.request(`/mcp/${encodedId}/probe`, "POST"), "MCP probe");
  if (action === "history") return writeApiResult(context, await context.request(`/mcp/${encodedId}/history`), "MCP history");
  const kind = action === "tool" ? "call" : action;
  await ensureConfirm(Boolean(options.confirm), `pgw mcp ${action} ${id}`);
  if (!options.name) throw new Error(`pgw mcp ${action} ${id} --name NAME --confirm`);
  return writeApiResult(context, await context.request(`/mcp/${encodedId}/${kind}`, "POST", { name: String(options.name), arguments: jsonBody(options.arguments) || {}, confirmed: true }), `MCP ${action}`);
}

export async function mcpCallsCommand(context: CliContext, action: "list" | "get" | "approve" | "deny" | "cancel", id: string | undefined, options: Options) {
  await context.ensureServer();
  if (action === "list") {
    const params = query(options, ["status"]);
    return writeApiResult(context, await context.request(`/mcp-calls${params ? `?${params}` : ""}`), "MCP calls");
  }
  if (!id) throw new Error(`pgw mcp-calls ${action} CALL_ID`);
  if (action === "get") return writeApiResult(context, await context.request(`/mcp-calls/${idPath(id)}`), "MCP call");
  await ensureConfirm(Boolean(options.confirm), `pgw mcp-calls ${action} ${id}`);
  const path = `/mcp-calls/${idPath(id)}/${action === "cancel" ? "cancel" : "decide"}`;
  return writeApiResult(context, await context.request(path, "POST", action === "cancel" ? undefined : { accept: action === "approve" }), `MCP call ${action}`);
}

export async function observabilityConfig(context: CliContext, action: "status" | "update", options: Options) {
  await context.ensureServer();
  if (action === "status") return writeApiResult(context, await context.request("/observability"), "Observability");
  await ensureConfirm(Boolean(options.confirm), "pgw observability settings update");
  const body = jsonBody(options.body);
  if (!body) throw new Error("Observability update requires --body JSON");
  return writeApiResult(context, await context.request("/observability", "PATCH", body), "Observability updated");
}

export async function observabilityCapture(context: CliContext, action: "inspect" | "stage" | "delete" | "purge", id: string | undefined, options: Options) {
  await context.ensureServer();
  if (action === "purge") {
    await ensureConfirm(Boolean(options.confirm), "pgw observability captures purge");
    return writeApiResult(context, await context.request("/observability/captures", "DELETE"), "Observability captures purged");
  }
  if (!id) throw new Error(`pgw observability captures ${action} TRAFFIC_ID`);
  const stage = action === "stage" ? `/${encodeURIComponent(String(options.stage || "request"))}` : "";
  const path = `/traffic/${idPath(id)}/capture${stage}`;
  if (action === "delete") {
    await ensureConfirm(Boolean(options.confirm), `pgw observability captures delete ${id}`);
    return writeApiResult(context, await context.request(path, "DELETE"), "Capture deleted");
  }
  const suffix = action === "stage" && options.after !== undefined ? `?after=${encodeURIComponent(String(options.after))}` : "";
  return writeApiResult(context, await context.request(`${path}${suffix}`), action === "stage" ? "Capture stage" : "Capture");
}

export async function trafficCommand(context: CliContext, action: "list" | "get" | "capture" | "delete-capture", id: string | undefined, options: Options) {
  await context.ensureServer();
  if (action === "list") {
    const params = query(options, ["limit", "offset", "query", "status"]);
    return writeApiResult(context, await context.request(`/traffic${params ? `?${params}` : ""}`), "Traffic requests");
  }
  if (!id) throw new Error(`pgw traffic ${action} TRAFFIC_ID`);
  if (action === "get") return writeApiResult(context, await context.request(`/traffic/${idPath(id)}`), "Traffic request");
  const stage = action === "capture" ? `/${encodeURIComponent(String(options.stage || "request"))}` : "";
  const path = `/traffic/${idPath(id)}/capture${stage}`;
  if (action === "delete-capture") {
    await ensureConfirm(Boolean(options.confirm), `pgw traffic delete-capture ${id}`);
    return writeApiResult(context, await context.request(`/traffic/${idPath(id)}/capture`, "DELETE"), "Traffic capture deleted");
  }
  const suffix = options.after !== undefined ? `?after=${encodeURIComponent(String(options.after))}` : "";
  return writeApiResult(context, await context.request(`${path}${suffix}`), "Traffic capture");
}

export async function routingCommand(context: CliContext, action: "sessions" | "circuits" | "delete-session" | "reset-circuit", id?: string, options: Options = {}) {
  await context.ensureServer();
  if (action === "sessions") return writeApiResult(context, await context.request("/routing/sessions"), "Routing sessions");
  if (action === "circuits") return writeApiResult(context, await context.request("/routing/circuits"), "Provider circuits");
  if (!id) throw new Error(`pgw routing ${action} ID`);
  await ensureConfirm(Boolean(options.confirm), `pgw routing ${action} ${id}`);
  const path = action === "delete-session" ? `/routing/sessions/${idPath(id)}` : `/routing/circuits/${idPath(id)}/reset`;
  return writeApiResult(context, await context.request(path, action === "delete-session" ? "DELETE" : "POST"), action === "delete-session" ? "Routing session deleted" : "Circuit reset");
}

function trajectoryParams(options: Options) {
  return query(options, ["stage", "format", "offset", "limit", "section", "block", "start", "against", "change", "side", "beforeStage", "afterStage", "revision", "kind", "id"]);
}

export async function trajectorySessions(context: CliContext, action: "list" | "nodes" | "node", key: string | undefined, options: Options) {
  await context.ensureServer();
  if (action === "list") {
    const params = query(options, ["kind", "query", "cursor", "limit", "minCalls", "maxCalls", "minEvents", "maxEvents"]);
    return writeApiResult(context, await context.request(`/trajectory/sessions${params ? `?${params}` : ""}`), "Trajectory sessions");
  }
  if (!key) throw new Error(`pgw trajectory sessions ${action} SESSION_KEY`);
  const params = action === "nodes" ? query(options, ["offset", "limit", "revision"]) : query(options, ["kind", "id", "start"]);
  return writeApiResult(context, await context.request(`/trajectory/sessions/${encodeURIComponent(key)}/${action}${params ? `?${params}` : ""}`), action === "nodes" ? "Trajectory nodes" : "Trajectory node");
}

export async function trajectoryCalls(context: CliContext, action: "inspect" | "diff", id: string, options: Options) {
  if (!id) throw new Error(`pgw trajectory calls ${action} CALL_ID`);
  await context.ensureServer();
  if (action === "diff" && !options.against) throw new Error("Trajectory diff requires --against CALL_ID");
  const params = trajectoryParams(options);
  return writeApiResult(context, await context.request(`/trajectory/calls/${idPath(id)}/${action}${params ? `?${params}` : ""}`), `Trajectory call ${action}`);
}

export async function trajectorySnapshots(context: CliContext, action: "list" | "create" | "inspect" | "diff" | "export" | "delete", id: string | undefined, options: Options) {
  await context.ensureServer();
  if (action === "list") {
    const params = query(options, ["key", "offset", "limit"]);
    return writeApiResult(context, await context.request(`/trajectory/snapshots${params ? `?${params}` : ""}`), "Trajectory snapshots");
  }
  if (action === "create") {
    await ensureConfirm(Boolean(options.confirm), "pgw trajectory snapshots create");
    const body = { ...bodyFrom(options, { key: options.key, kind: options.kind, nodeId: options.nodeId, label: options.label, retentionDays: options.retentionDays ? Number(options.retentionDays) : 7 }), confirmed: true };
    return writeApiResult(context, await context.request("/trajectory/snapshots", "POST", body), "Trajectory snapshot created");
  }
  if (!id) throw new Error(`pgw trajectory snapshots ${action} SNAPSHOT_ID`);
  if (action === "delete") {
    await ensureConfirm(Boolean(options.confirm), `pgw trajectory snapshots delete ${id}`);
    return writeApiResult(context, await context.request(`/trajectory/snapshots/${idPath(id)}`, "DELETE"), "Trajectory snapshot deleted");
  }
  if (action === "diff" && !options.against) throw new Error("Snapshot diff requires --against SNAPSHOT_ID");
  const params = trajectoryParams(options);
  return writeApiResult(context, await context.request(`/trajectory/snapshots/${idPath(id)}/${action}${params ? `?${params}` : ""}`), `Trajectory snapshot ${action}`);
}

export async function preferencesCommand(context: CliContext, action: "list" | "from-event" | "history" | "restore" | "timeline", id: string | undefined, options: Options) {
  await context.ensureServer();
  if (action === "list") return writeApiResult(context, await context.request("/preferences"), "Preferences");
  if (action === "timeline") return writeApiResult(context, await context.request("/preferences/timeline"), "Preference timeline");
  if (action === "from-event") {
    await ensureConfirm(Boolean(options.confirm), "pgw preferences from-event");
    return writeApiResult(context, await context.request("/preferences/from-event", "POST", bodyFrom(options, { eventId: options.eventId, title: options.title, scope: options.scope || "global" })), "Preference created from event");
  }
  if (!id) throw new Error(`pgw preferences ${action} PREFERENCE_ID`);
  if (action === "history") return writeApiResult(context, await context.request(`/preferences/${idPath(id)}/history`), "Preference history");
  await ensureConfirm(Boolean(options.confirm), `pgw preferences restore ${id}`);
  if (options.revision === undefined) throw new Error("Preference restore requires --revision N");
  return writeApiResult(context, await context.request(`/preferences/${idPath(id)}/restore`, "POST", { revision: Number(options.revision) }), "Preference restored");
}

export async function runDetails(context: CliContext, action: "events" | "budget", id: string) {
  if (!id) throw new Error(`pgw runs ${action} RUN_ID`);
  await context.ensureServer();
  return writeApiResult(context, await context.request(`/runs/${idPath(id)}/${action}`), `Run ${action}`);
}

export async function inventoryExport(context: CliContext) {
  await context.ensureServer();
  return writeApiResult(context, await context.request("/inventory"), "Inventory export");
}

export async function jobsQuery(context: CliContext, options: Options) {
  await context.ensureServer();
  const params = query(options, ["offset", "limit", "status", "kind"]);
  return writeApiResult(context, await context.request(`/jobs${params ? `?${params}` : ""}`), "Background jobs");
}

export async function jobDetailCommand(context: CliContext, action: "get" | "attempts" | "attempt", jobId: string, attemptId?: string) {
  if (!jobId) throw new Error(`pgw jobs ${action} JOB_ID`);
  await context.ensureServer();
  const path = action === "get" ? `/jobs/${idPath(jobId)}` : `/jobs/${idPath(jobId)}/attempts${attemptId ? `/${idPath(attemptId)}` : ""}`;
  return writeApiResult(context, await context.request(path), action === "get" ? "Job" : attemptId ? "Job attempt" : "Job attempts");
}
