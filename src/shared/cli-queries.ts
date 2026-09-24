import { parseArgs } from "node:util";

export const cliQueryCommands = [
  "status",
  "sources",
  "sessions",
  "persona",
  "skills",
  "asset-roots",
  "asset-installs",
  "jobs",
  "mcp",
  "export",
] as const;

export type CliQueryCommand = (typeof cliQueryCommands)[number];

export function cliQueryPath(command: string, args: string[] = []) {
  switch (command) {
    case "status":
      if (args.length) throw new Error("status does not accept arguments");
      return "/status";
    case "sources":
      if (args.length) throw new Error("sources does not accept arguments");
      return "/sources";
    case "sessions": {
      const { values } = parseArgs({
        args,
        options: {
          query: { type: "string" },
          agent: { type: "string" },
          offset: { type: "string" },
        },
        strict: true,
      });
      const params = new URLSearchParams({ paged: "1" });
      for (const [key, value] of Object.entries(values))
        if (value !== undefined) params.set(key, String(value));
      return `/sessions?${params}`;
    }
    case "persona":
      if (!args.length) return "/preferences";
      if (args[0] === "timeline" && args.length === 1)
        return "/preferences/timeline";
      if (args[0] === "history" && args.length === 2)
        return `/preferences/${encodeURIComponent(args[1])}/history`;
      throw new Error(
        "persona | persona timeline | persona history PREFERENCE_ID",
      );
    case "skills":
      return `/skills?query=${encodeURIComponent(args.join(" "))}`;
    case "asset-roots":
      if (args.length) throw new Error("asset-roots does not accept arguments");
      return "/asset-roots";
    case "asset-installs":
      if (args.length)
        throw new Error("asset-installs does not accept arguments");
      return "/asset-deployments";
    case "jobs":
      if (args.length) throw new Error("jobs does not accept arguments");
      return "/jobs";
    case "mcp":
      if (!args.length) return "/mcp";
      if (args.length === 1 && args[0] === "calls") return "/mcp-calls";
      throw new Error("mcp | mcp calls");
    case "export":
      if (args.length) throw new Error("export does not accept arguments");
      return "/inventory";
    default:
      throw new Error(`Unknown read-only command: ${command}`);
  }
}

export function scopeCliQueryPath(
  path: string,
  project: string | null | undefined,
) {
  if (!project || !path.startsWith("/sessions?")) return path;
  const url = new URL(`http://gateway${path}`);
  url.searchParams.set("project", project);
  return `${url.pathname}?${url.searchParams}`;
}
