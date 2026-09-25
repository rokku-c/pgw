import { cliQueryPath } from "../../shared/cli-queries";
import { formatStatus, renderSummary, renderTable, truncate, writeValue } from "../output";
import type { CliContext } from "../types";

function records(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const key of ["items", "data", "results", "jobs", "sources", "calls"]) {
      if (Array.isArray(object[key])) return records(object[key]);
    }
  }
  return [];
}

function firstValue(record: Record<string, unknown>, keys: string[]) {
  return keys.map((key) => record[key]).find((value) => value !== undefined && value !== null);
}

function renderRecords(command: string, value: unknown, options: CliContext["options"]) {
  const items = records(value);
  if (!items.length) {
    if (value && typeof value === "object") {
      return renderSummary(command, Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => typeof item !== "object")));
    }
    return `${command}: ${String(value ?? "No results.")}`;
  }
  if (command === "status") {
    return renderSummary("Gateway status", Object.fromEntries(Object.entries(items[0]).slice(0, 8).map(([key, item]) => [key, typeof item === "object" ? JSON.stringify(item) : item])));
  }
  const rows = items.slice(0, 100).map((item) => ({
    id: truncate(firstValue(item, ["id", "key", "name"]), 28),
    name: truncate(firstValue(item, ["name", "title", "alias", "label", "description"]), 42),
    status: formatStatus(firstValue(item, ["status", "state", "enabled"]), options),
    detail: truncate(firstValue(item, ["path", "agent", "kind", "model", "project", "createdAt"]), 32),
  }));
  return renderTable(
    [
      { key: "id", label: "ID", width: 28 },
      { key: "name", label: "NAME", width: 42 },
      { key: "status", label: "STATUS", width: 18 },
      { key: "detail", label: "DETAIL", width: 32 },
    ],
    rows,
  );
}

export async function queryCommand(context: CliContext, command: string, args: string[] = []) {
  await context.ensureServer();
  const queryArgs: string[] = [];
  let limit: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--limit") limit = args[++index];
    else queryArgs.push(args[index]);
  }
  let path = command === "jobs" ? "/jobs" : cliQueryPath(command, queryArgs);
  if (command === "jobs") {
    const params = new URLSearchParams();
    for (let index = 0; index < queryArgs.length; index += 1) {
      if (["--offset", "--query", "--agent"].includes(queryArgs[index])) params.set(queryArgs[index].slice(2), queryArgs[++index]);
    }
    path = params.toString() ? `${path}?${params}` : path;
  }
  if (limit && (command === "sessions" || command === "jobs")) {
    const url = new URL(`http://pgw${path}`);
    url.searchParams.set("limit", limit);
    path = `${url.pathname}?${url.searchParams}`;
  }
  const value = await context.request(path);
  writeValue(value, context.options, renderRecords(command, value, context.options));
}

export async function statusCommand(context: CliContext) {
  return queryCommand(context, "status");
}
