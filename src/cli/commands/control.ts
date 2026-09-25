import { cliQueryPath } from "../../shared/cli-queries";
import type { CollectionSource } from "../../shared/types";
import { ensureConfirm } from "./system";
import { renderSummary, renderTable, truncate, writeRaw, writeValue } from "../output";
import type { CliContext } from "../types";

export { ensureConfirm } from "./system";

function humanValue(value: unknown, title: string) {
  if (Array.isArray(value)) {
    return renderTable(
      [{ key: "id", label: "ID", width: 28 }, { key: "name", label: "NAME", width: 36 }, { key: "status", label: "STATUS", width: 18 }, { key: "detail", label: "DETAIL", width: 36 }],
      value.slice(0, 100).map((item) => {
        const record: Record<string, unknown> = item && typeof item === "object" ? item as Record<string, unknown> : { value: item };
        return { id: truncate(record["id"] ?? record["key"] ?? record["name"], 28), name: truncate(record["name"] ?? record["alias"] ?? record["title"] ?? record["label"], 36), status: truncate(record["status"] ?? record["state"] ?? record["enabled"], 18), detail: truncate(record["path"] ?? record["protocol"] ?? record["kind"] ?? record["model"] ?? record["createdAt"], 36) };
      }),
    );
  }
  if (value && typeof value === "object") {
    const flat = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry === null || typeof entry !== "object"));
    return renderSummary(title, flat);
  }
  if (typeof value === "string") return `${title}\n${truncate(value, 4000)}`;
  return `${title}: ${String(value ?? "—")}`;
}

export async function writeApiResult(context: CliContext, value: unknown, title: string) {
  writeValue(value, context.options, humanValue(value, title));
}

export async function runAction(context: CliContext, runId: string, action: "pause" | "stop" | "complete") {
  if (!runId) throw new Error(`pgw ${action} RUN_ID`);
  await context.ensureServer();
  const result = await context.request(`/runs/${encodeURIComponent(runId)}/${action}`, "POST");
  await writeApiResult(context, result, `Run ${action}`);
}

export async function resumeRun(context: CliContext, runId: string, options: Record<string, unknown>) {
  if (!runId) throw new Error("pgw resume RUN_ID [--message TEXT] [--extra-turns N] [--extra-seconds N]");
  await context.ensureServer();
  const result = await context.request(`/runs/${encodeURIComponent(runId)}/resume`, "POST", { message: options.message, extraTurns: options.extraTurns ? Number(options.extraTurns) : undefined, extraSeconds: options.extraSeconds ? Number(options.extraSeconds) : undefined, budgetMicros: options.budgetUsd ? Math.round(Number(options.budgetUsd) * 1e6) : undefined, tokenLimit: options.tokenLimit ? Number(options.tokenLimit) : undefined });
  await writeApiResult(context, result, "Run resumed");
}

export async function steerRun(context: CliContext, runId: string, message: string[]) {
  if (!runId || !message.length) throw new Error("pgw steer RUN_ID MESSAGE");
  await context.ensureServer();
  await writeApiResult(context, await context.request(`/runs/${encodeURIComponent(runId)}/steer`, "POST", { message: message.join(" ") }), "Run steering");
}

export async function approvals(context: CliContext) {
  await context.ensureServer();
  const value = { native: await context.request("/approvals"), mcp: await context.request("/mcp-calls?status=pending") };
  await writeApiResult(context, value, "Pending approvals");
}

export async function decideApproval(context: CliContext, id: string, accept: boolean) {
  if (!id) throw new Error(`pgw ${accept ? "approve" : "deny"} APPROVAL_ID`);
  await context.ensureServer();
  await writeApiResult(context, await context.request(`/approvals/${encodeURIComponent(id)}`, "POST", { accept }), accept ? "Approval accepted" : "Approval denied");
}

export async function mcpAction(context: CliContext, action?: string, id?: string) {
  await context.ensureServer();
  if (!action) return writeApiResult(context, await context.request(cliQueryPath("mcp")), "MCP connections");
  if (action === "calls") return writeApiResult(context, await context.request(cliQueryPath("mcp", ["calls"])), "MCP calls");
  if (!id || !["approve", "deny", "cancel"].includes(action)) throw new Error("pgw mcp | mcp calls | mcp approve|deny|cancel CALL_ID");
  if (action === "cancel") return writeApiResult(context, await context.request(`/mcp-calls/${encodeURIComponent(id)}/cancel`, "POST"), "MCP call cancelled");
  return writeApiResult(context, await context.request(`/mcp-calls/${encodeURIComponent(id)}/decide`, "POST", { accept: action === "approve" }), action === "approve" ? "MCP call accepted" : "MCP call denied");
}

export async function scanRegistry(context: CliContext) {
  await context.ensureServer();
  await writeApiResult(context, await context.request("/registry/scan", "POST"), "Registry scan");
}

export async function sourceAction(context: CliContext, action: string, idOrPath: string, options: Record<string, unknown>) {
  if (!action || !idOrPath) throw new Error("pgw source add PATH --name NAME | pause SOURCE_ID | scan SOURCE_ID");
  await context.ensureServer();
  if (action === "add") {
    return writeApiResult(context, await context.request("/sources", "POST", { name: options.name || "Local sessions", agent: options.agent || "auto", path: idOrPath, enabled: true, captureBodies: Boolean(options.capture), learn: Boolean(options.learn) }), "Source added");
  }
  if (action === "scan") return writeApiResult(context, await context.request(`/sources/${encodeURIComponent(idOrPath)}/scan`, "POST"), "Source scan");
  if (action === "pause") {
    const sources = await context.request<CollectionSource[]>("/sources");
    const source = sources.find((item) => item.id === idOrPath);
    if (!source) throw new Error("Source not found");
    return writeApiResult(context, await context.request(`/sources/${encodeURIComponent(idOrPath)}`, "PATCH", { ...source, enabled: false }), "Source paused");
  }
  throw new Error("source action must be add, pause, or scan");
}

export async function assetAction(context: CliContext, action: string, id?: string, options: Record<string, unknown> = {}) {
  await context.ensureServer();
  if (["snapshot", "asset-snapshot"].includes(action)) {
    if (!id) throw new Error("pgw asset-snapshot ASSET_ID");
    return writeApiResult(context, await context.request(`/assets/${encodeURIComponent(id)}/snapshot`, "POST", { confirmed: true }), "Asset snapshot");
  }
  if (["preview", "asset-preview"].includes(action)) {
    if (!id || !options.snapshot || !options.target || !options.name) throw new Error("pgw asset-preview ASSET_ID --snapshot ID --target DIRECTORY --name NAME");
    return writeApiResult(context, await context.request(`/assets/${encodeURIComponent(id)}/deploy`, "POST", { snapshotId: options.snapshot, targetRoot: options.target, name: options.name, agent: options.agent || "shared" }), "Asset deployment preview");
  }
  if (["apply", "restore", "asset-apply", "asset-restore"].includes(action)) {
    if (!id) throw new Error(`pgw asset-${action.replace("asset-", "")} PLAN_ID --confirm`);
    await ensureConfirm(Boolean(options.confirm), `pgw asset-${action.replace("asset-", "")} ${id}`);
    const endpoint = action.includes("restore") ? "restore" : "apply";
    return writeApiResult(context, await context.request(`/asset-deployments/${encodeURIComponent(id)}/${endpoint}`, "POST", { confirmed: true }), `Asset ${endpoint}`);
  }
  throw new Error("asset action must be snapshot, preview, apply, or restore");
}

export async function resourceCommand(context: CliContext, resource: string, operation = "list", id?: string, options: Record<string, unknown> = {}) {
  await context.ensureServer();
  let path = `/${resource}${id ? `/${id.split("/").map((part) => encodeURIComponent(part)).join("/")}` : ""}`;
  if (operation === "list" && !id) {
    const params = new URLSearchParams();
    for (const key of ["limit", "offset", "query"]) if (options[key] !== undefined) params.set(key, String(options[key]));
    if (params.toString()) path = `${path}?${params}`;
  }
  const body = options.body ? JSON.parse(String(options.body)) : undefined;
  const method = operation === "get" || operation === "list" ? "GET" : operation === "delete" ? "DELETE" : operation === "patch" ? "PATCH" : "POST";
  if (method !== "GET") await ensureConfirm(Boolean(options.confirm), `pgw ${resource} ${operation}`);
  await writeApiResult(context, await context.request(path, method, body), `${resource} ${operation}`);
}

export async function purgeStorage(context: CliContext, options: Record<string, unknown>) {
  await ensureConfirm(Boolean(options.confirm), "pgw storage purge");
  await context.ensureServer();
  await writeApiResult(context, await context.request("/storage/purge", "POST", { categories: options.categories ? String(options.categories).split(",") : undefined }), "Storage purge");
}
