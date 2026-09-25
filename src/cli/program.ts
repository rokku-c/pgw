import { Command, Option } from "commander";
import { apiVersion, createContext, version } from "./context";
import { queryCommand } from "./commands/query";
import { runDoctor, openGateway, startGateway, storageCommand } from "./commands/system";
import { startRun, wrapAgent } from "./commands/agents";
import { assetAction, approvals, decideApproval, mcpAction, purgeStorage, resourceCommand, runAction, scanRegistry, sourceAction, steerRun, resumeRun } from "./commands/control";
import {
  assetCommand,
  assetRootsCommand,
  inventoryExport,
  jobDetailCommand,
  jobsQuery,
  mcpCallsCommand,
  mcpConnectionCommand,
  observabilityCapture,
  observabilityConfig,
  preferencesCommand,
  runDetails,
  routingCommand,
  skillsCommand,
  sourceEdit,
  sourceSpecial,
  trajectoryCalls,
  trajectorySessions,
  trajectorySnapshots,
  trafficCommand,
} from "./commands/specialized";

type Options = Record<string, unknown>;

function context(program: Command) {
  return createContext(program.opts());
}

function bodyOptions(command: Command) {
  return command.option("--body <json>", "JSON request body");
}

function requiredBodyOptions(command: Command) {
  return command.requiredOption("--body <json>", "JSON request body");
}

function query(program: Command, name: string, description: string, args: (options: Options) => string[] = () => []) {
  const command = program.command(name).description(description).option("--limit <n>", "Maximum rows").option("--offset <n>", "Rows to skip").option("--query <text>", "Search text").option("--agent <name>", "Filter by agent");
  command.action(async (options: Options) => queryCommand(context(program), name, args(options)));
  return command;
}

function resource(program: Command, name: string, description: string, operations: { create?: boolean; patch?: boolean; delete?: boolean } = {}) {
  const allowCreate = operations.create ?? true;
  const allowPatch = operations.patch ?? true;
  const allowDelete = operations.delete ?? true;
  const command = program.command(name).description(description).option("--limit <n>", "Maximum rows").option("--offset <n>", "Rows to skip").option("--query <text>", "Search text");
  command.action(async (options: Options) => resourceCommand(context(program), name, "list", undefined, options));
  command.command("get <id>").description(`Show one ${name}`).action(async (id: string) => resourceCommand(context(program), name, "get", id));
  if (allowCreate) requiredBodyOptions(command.command("create").description(`Create a ${name.slice(0, -1)}`)).requiredOption("--confirm").action(async (options: Options) => resourceCommand(context(program), name, "create", undefined, options));
  if (allowPatch) requiredBodyOptions(command.command("patch <id>").description(`Update one ${name.slice(0, -1)}`)).requiredOption("--confirm").action(async (id: string, options: Options) => resourceCommand(context(program), name, "patch", id, options));
  if (allowDelete) command.command("delete <id>").description(`Delete one ${name.slice(0, -1)}`).requiredOption("--confirm").action(async (id: string, options: Options) => resourceCommand(context(program), name, "delete", id, options));
  return command;
}

function addTrajectoryOptions(command: Command) {
  return command.option("--stage <stage>", "request|effective|upstream|response|output|node").option("--format <format>", "structured|raw|manifest").option("--offset <n>").option("--limit <n>").option("--section <section>").option("--block <name>").option("--start <n>").option("--against <id>").option("--change <n>").option("--side <side>").option("--before-stage <stage>").option("--after-stage <stage>");
}

export function createProgram() {
  const program = new Command();
  program.name("pgw").description("Personal Gateway native CLI").version(`pgw v${version} · API v${apiVersion}`, "-v, --version").addOption(new Option("--json", "Emit pure JSON")).addOption(new Option("--raw", "Print complete response content")).addOption(new Option("--quiet", "Suppress normal output")).addOption(new Option("--no-color", "Disable ANSI color")).addOption(new Option("--access <clientId>", "Use an MCP access client when launching an agent"));
  program.showSuggestionAfterError();
  program.action(() => program.outputHelp());

  program.command("open").alias("ui").description("Start the gateway and open the browser UI").action(async () => openGateway(context(program)));
  program.command("start").description("Start the gateway in the foreground").action(async () => startGateway(context(program)));
  program.command("status").description("Show gateway status").action(async () => queryCommand(context(program), "status"));
  program.command("doctor").description("Run local diagnostics").action(async () => { const cli = context(program); await cli.ensureServer(); await runDoctor(cli); });

  const storage = program.command("storage").description("Inspect or maintain local storage");
  storage.action(async () => storageCommand(context(program), "status"));
  storage.command("status").description("Show storage status").action(async () => storageCommand(context(program), "status"));
  storage.command("usage").description("Show storage usage").action(async () => resourceCommand(context(program), "storage/usage", "list"));
  storage.command("compact").description("Compact stopped storage").requiredOption("--confirm").action(async () => storageCommand(context(program), "compact"));
  storage.command("purge").description("Purge selected storage categories").requiredOption("--categories <list>").requiredOption("--confirm").action(async (options: Options) => purgeStorage(context(program), options));

  query(program, "sources", "List registered sources");
  query(program, "sessions", "Search indexed sessions", (options) => [ ...(options.query ? ["--query", String(options.query)] : []), ...(options.agent ? ["--agent", String(options.agent)] : []), ...(options.offset ? ["--offset", String(options.offset)] : []), ...(options.limit ? ["--limit", String(options.limit)] : []) ]);
  query(program, "persona", "List persona preferences");
  const persona = program.commands.find((item) => item.name() === "persona") as Command;
  persona.command("timeline").description("Show preference timeline").action(async () => preferencesCommand(context(program), "timeline", undefined, {}));
  persona.command("history <id>").description("Show preference history").action(async (id: string) => preferencesCommand(context(program), "history", id, {}));

  const preferences = program.command("preferences").alias("preference").description("Manage learned preferences");
  preferences.action(async () => preferencesCommand(context(program), "list", undefined, {}));
  preferences.command("from-event").description("Create a preference from an event").requiredOption("--event-id <id>").option("--title <title>").option("--scope <scope>", "global|project", "global").requiredOption("--confirm").action(async (options: Options) => preferencesCommand(context(program), "from-event", undefined, options));
  preferences.command("history <id>").description("Show preference revisions").action(async (id: string) => preferencesCommand(context(program), "history", id, {}));
  preferences.command("restore <id>").description("Restore a preference revision").requiredOption("--revision <n>").requiredOption("--confirm").action(async (id: string, options: Options) => preferencesCommand(context(program), "restore", id, options));
  preferences.command("timeline").description("Show preference timeline").action(async () => preferencesCommand(context(program), "timeline", undefined, {}));

  const skills = program.command("skills").description("Search installed skills").option("--query <text>").option("--offset <n>").option("--limit <n>").option("--root-id <id>").option("--duplicates <true|false>");
  skills.action(async (options: Options) => skillsCommand(context(program), options));

  const roots = program.command("asset-roots").description("Manage skill asset roots");
  roots.action(async () => assetRootsCommand(context(program), "list", undefined, {}));
  roots.command("list").description("List asset roots").action(async () => assetRootsCommand(context(program), "list", undefined, {}));
  requiredBodyOptions(roots.command("create").description("Create an asset root")).requiredOption("--confirm").action(async (options: Options) => assetRootsCommand(context(program), "create", undefined, options));
  requiredBodyOptions(roots.command("patch <id>").description("Update an asset root")).requiredOption("--confirm").action(async (id: string, options: Options) => assetRootsCommand(context(program), "patch", id, options));
  roots.command("scan <id>").description("Scan an asset root").action(async (id: string) => assetRootsCommand(context(program), "scan", id, {}));
  roots.command("delete <id>").description("Delete an asset root (not supported by current API)").requiredOption("--confirm").action(async (id: string, options: Options) => assetRootsCommand(context(program), "delete", id, options));

  const assets = program.command("assets").description("Inspect skills and deployments");
  assets.command("list").description("List assets").action(async () => assetCommand(context(program), "list", undefined, {}));
  assets.command("inspect <id>").description("Inspect an asset").action(async (id: string) => assetCommand(context(program), "inspect", id, {}));
  assets.command("snapshot <id>").description("Create an asset snapshot").requiredOption("--confirm").action(async (id: string, options: Options) => assetCommand(context(program), "snapshot", id, options));
  assets.command("preview <id>").description("Preview an asset deployment").requiredOption("--snapshot <id>").requiredOption("--target <directory>").requiredOption("--name <name>").option("--agent <agent>", "claude|codex|pi|shared", "shared").action(async (id: string, options: Options) => assetCommand(context(program), "preview", id, options));
  assets.command("deployments").description("List asset deployments").action(async () => assetCommand(context(program), "deployments", undefined, {}));
  assets.command("apply <id>").description("Apply an asset deployment").requiredOption("--confirm").action(async (id: string, options: Options) => assetCommand(context(program), "apply", id, options));
  assets.command("restore <id>").description("Restore an asset deployment").requiredOption("--confirm").action(async (id: string, options: Options) => assetCommand(context(program), "restore", id, options));
  query(program, "asset-installs", "List asset deployments");
  program.command("export").alias("inventory").description("Export gateway inventory").action(async () => inventoryExport(context(program)));

  const jobs = program.command("jobs").description("Inspect background jobs").option("--limit <n>").option("--offset <n>").option("--status <status>").option("--kind <kind>");
  jobs.action(async (options: Options) => jobsQuery(context(program), options));
  jobs.command("list").description("List jobs with filters").option("--limit <n>").option("--offset <n>").option("--status <status>").option("--kind <kind>").action(async (options: Options) => jobsQuery(context(program), options));
  jobs.command("get <id>").description("Show one job").action(async (id: string) => jobDetailCommand(context(program), "get", id));
  jobs.command("attempts <id>").description("List job attempts").action(async (id: string) => jobDetailCommand(context(program), "attempts", id));
  jobs.command("attempt <jobId> <attemptId>").description("Show one job attempt").action(async (jobId: string, attemptId: string) => jobDetailCommand(context(program), "attempt", jobId, attemptId));
  jobs.command("cancel <id>").description("Cancel a job").requiredOption("--confirm").action(async (id: string, options: Options) => resourceCommand(context(program), "jobs", "post", `${id}/cancel`, options));
  jobs.command("retry <id>").description("Retry a job").requiredOption("--confirm").action(async (id: string, options: Options) => resourceCommand(context(program), "jobs", "post", `${id}/retry`, { ...options, body: JSON.stringify({ confirmed: true }) }));

  program.command("scan").description("Scan configured asset/session sources").action(async () => scanRegistry(context(program)));
  const source = program.command("source").description("Manage one source");
  source.command("add <path>").description("Register a session source").option("--name <name>").option("--agent <agent>").option("--capture").option("--learn").action(async (path: string, options: Options) => sourceAction(context(program), "add", path, options));
  requiredBodyOptions(source.command("edit <id>").description("Update a source")).requiredOption("--confirm").action(async (id: string, options: Options) => sourceEdit(context(program), id, options));
  source.command("remove <id>").description("Remove a source").requiredOption("--confirm").action(async (id: string, options: Options) => sourceSpecial(context(program), "remove", id, options));
  source.command("restore <id>").description("Restore a removed source").requiredOption("--confirm").action(async (id: string, options: Options) => sourceSpecial(context(program), "restore", id, options));
  source.command("pause <id>").description("Pause a source (compatibility alias)").action(async (id: string) => sourceAction(context(program), "pause", id, {}));
  source.command("scan <id>").description("Scan a source").action(async (id: string) => sourceAction(context(program), "scan", id, {}));

  for (const [name, action] of [["asset-snapshot", "snapshot"], ["asset-preview", "preview"], ["asset-apply", "apply"], ["asset-restore", "restore"]] as const) {
    const command = program.command(name).description(`Compatibility alias for assets ${action}`).argument("<id>");
    if (action === "snapshot") command.requiredOption("--confirm");
    if (action === "preview") command.requiredOption("--snapshot <id>").requiredOption("--target <directory>").requiredOption("--name <name>").option("--agent <agent>", "shared");
    if (action === "apply" || action === "restore") command.requiredOption("--confirm");
    command.action(async (id: string, options: Options) => assetCommand(context(program), action, id, options));
  }

  const mcp = program.command("mcp").description("Manage MCP connections and debug calls");
  mcp.action(async () => mcpConnectionCommand(context(program), "list", undefined, {}));
  mcp.command("list").description("List MCP connections").action(async () => mcpConnectionCommand(context(program), "list", undefined, {}));
  mcp.command("catalog").description("Show connection catalog summaries").action(async () => mcpConnectionCommand(context(program), "catalog", undefined, {}));
  requiredBodyOptions(mcp.command("create").description("Create an MCP connection")).requiredOption("--confirm").action(async (options: Options) => mcpConnectionCommand(context(program), "create", undefined, options));
  requiredBodyOptions(mcp.command("patch <id>").description("Enable or disable an MCP connection")).requiredOption("--confirm").action(async (id: string, options: Options) => mcpConnectionCommand(context(program), "patch", id, options));
  mcp.command("delete <id>").description("Delete an MCP connection").requiredOption("--confirm").action(async (id: string, options: Options) => mcpConnectionCommand(context(program), "delete", id, options));
  mcp.command("probe <id>").description("Probe an MCP connection").action(async (id: string) => mcpConnectionCommand(context(program), "probe", id, {}));
  mcp.command("history <id>").description("Show MCP catalog revisions").action(async (id: string) => mcpConnectionCommand(context(program), "history", id, {}));
  for (const action of ["tool", "call", "resource", "prompt"] as const) mcp.command(`${action} <id>`).description(`Debug an MCP ${action}`).requiredOption("--name <name>").option("--arguments <json>").requiredOption("--confirm").action(async (id: string, options: Options) => mcpConnectionCommand(context(program), action, id, options));
  mcp.command("calls").description("List MCP calls (compatibility alias)").option("--status <status>").action(async (options: Options) => mcpCallsCommand(context(program), "list", undefined, options));
  const mcpCalls = program.command("mcp-calls").description("Review and control MCP calls");
  mcpCalls.action(async (options: Options) => mcpCallsCommand(context(program), "list", undefined, options));
  mcpCalls.command("list").description("List MCP calls").option("--status <status>").action(async (options: Options) => mcpCallsCommand(context(program), "list", undefined, options));
  mcpCalls.command("get <id>").description("Inspect one MCP call").action(async (id: string) => mcpCallsCommand(context(program), "get", id, {}));
  for (const action of ["approve", "deny", "cancel"] as const) mcpCalls.command(`${action} <id>`).description(`${action} an MCP call`).requiredOption("--confirm").action(async (id: string, options: Options) => mcpCallsCommand(context(program), action, id, options));
  program.command("approvals").description("List pending approvals").action(async () => approvals(context(program)));
  program.command("approve <id>").description("Approve a pending request").requiredOption("--confirm").action(async (id: string) => decideApproval(context(program), id, true));
  program.command("deny <id>").description("Deny a pending request").requiredOption("--confirm").action(async (id: string) => decideApproval(context(program), id, false));

  const run = program.command("run").description("Start a managed agent run");
  for (const agent of ["codex", "claude", "pi"] as const) run.command(agent).requiredOption("--goal <text>").option("--workspace <path>", process.cwd()).option("--model <alias>").option("--timeout <duration>", "1800").option("--max-turns <n>", "20").option("--budget-usd <amount>").option("--token-limit <n>").option("--coordinator <mode>", "off").option("--permission <mode>", "read-only").option("--completion-file <path>", "Completion file", (value, previous: string[] = []) => [...previous, value], []).option("--single-turn").action(async (options: Options) => startRun(context(program), agent, options));
  for (const agent of ["claude", "codex", "pi"] as const) program.command(agent).description(`Launch ${agent} through the gateway`).argument("[args...]", "Arguments passed to the native agent").action(async (args: string[]) => wrapAgent(context(program), agent, args || []));
  for (const action of ["pause", "stop", "complete"] as const) program.command(action).argument("<runId>").description(`${action} a managed run`).requiredOption("--confirm").action(async (runId: string, options: Options) => runAction(context(program), runId, action));
  program.command("resume").argument("<runId>").option("--message <text>").option("--extra-turns <n>").option("--extra-seconds <n>").option("--budget-usd <amount>").option("--token-limit <n>").action(async (runId: string, options: Options) => resumeRun(context(program), runId, options));
  program.command("steer").argument("<runId>").argument("<message...>").action(async (runId: string, message: string[]) => steerRun(context(program), runId, message));

  resource(program, "providers", "List and manage providers");
  resource(program, "routes", "List and manage routes");
  resource(program, "clients", "List and manage access clients");
  const settings = program.command("settings").description("Read and update gateway settings");
  settings.action(async () => resourceCommand(context(program), "settings", "list"));
  requiredBodyOptions(settings.command("patch").description("Update gateway settings")).requiredOption("--confirm").action(async (options: Options) => resourceCommand(context(program), "settings", "patch", undefined, options));
  const runs = resource(program, "runs", "List and inspect managed runs", { create: false, patch: false, delete: false });
  runs.command("events <id>").description("Show run events").action(async (id: string) => runDetails(context(program), "events", id));
  runs.command("budget <id>").description("Show run budget").action(async (id: string) => runDetails(context(program), "budget", id));

  const dashboard = program.command("dashboard").alias("traffic").description("Show traffic and usage summary").option("--recent-limit <n>", "Recent requests to include", "8");
  dashboard.action(async (options: Options) => { const cli = context(program); await cli.ensureServer(); const value = await cli.request(`/dashboard?recentLimit=${encodeURIComponent(String(options.recentLimit))}`); const { writeValue } = await import("./output"); writeValue(value, cli.options, `Traffic dashboard\nRequests: ${String((value as { requests?: unknown }).requests ?? "—")}\nRunning: ${String((value as { running?: unknown }).running ?? "—")}\nCompleted: ${String((value as { completed?: unknown }).completed ?? "—")}\nTokens: ${String((value as { tokens?: unknown }).tokens ?? "—")}`); });
  dashboard.command("list").description("List traffic requests").option("--limit <n>").option("--offset <n>").option("--query <text>").option("--status <status>").action(async (options: Options) => trafficCommand(context(program), "list", undefined, options));
  dashboard.command("get <id>").description("Show one traffic request").action(async (id: string) => trafficCommand(context(program), "get", id, {}));
  dashboard.command("capture <id>").description("Read one captured stage").option("--stage <stage>").option("--after <n>").action(async (id: string, options: Options) => trafficCommand(context(program), "capture", id, options));
  dashboard.command("delete-capture <id>").description("Delete captured content").requiredOption("--confirm").action(async (id: string, options: Options) => trafficCommand(context(program), "delete-capture", id, options));

  const routing = program.command("routing").description("Inspect and reset routing state");
  routing.command("sessions").description("List sticky routing sessions").action(async () => routingCommand(context(program), "sessions"));
  routing.command("circuits").description("List provider circuits").action(async () => routingCommand(context(program), "circuits"));
  routing.command("delete-session <id>").description("Delete one routing session").requiredOption("--confirm").action(async (id: string, options: Options) => routingCommand(context(program), "delete-session", id, options));
  routing.command("reset-circuit <id>").description("Reset one provider circuit").requiredOption("--confirm").action(async (id: string, options: Options) => routingCommand(context(program), "reset-circuit", id, options));

  const observability = program.command("observability").description("Inspect and configure observability");
  observability.command("settings").description("Show observability settings").action(async () => observabilityConfig(context(program), "status", {}));
  requiredBodyOptions(observability.command("update").description("Update observability settings")).requiredOption("--confirm").action(async (options: Options) => observabilityConfig(context(program), "update", options));
  const captures = observability.command("captures").description("Inspect or purge captured content");
  captures.command("inspect <id>").description("Inspect a capture").action(async (id: string) => observabilityCapture(context(program), "inspect", id, {}));
  captures.command("stage <id>").description("Read one capture stage").option("--stage <stage>").option("--after <n>").action(async (id: string, options: Options) => observabilityCapture(context(program), "stage", id, options));
  captures.command("delete <id>").description("Delete one capture").requiredOption("--confirm").action(async (id: string, options: Options) => observabilityCapture(context(program), "delete", id, options));
  captures.command("purge").description("Delete all captures").requiredOption("--confirm").action(async (options: Options) => observabilityCapture(context(program), "purge", undefined, options));

  const trajectory = program.command("trajectory").description("Explore sessions, calls, and snapshots");
  const trajectorySessionsCommand = trajectory.command("sessions").description("List trajectory sessions");
  trajectorySessionsCommand.action(async (options: Options) => trajectorySessions(context(program), "list", undefined, options));
  trajectorySessionsCommand.option("--kind <kind>").option("--query <text>").option("--cursor <cursor>").option("--limit <n>").option("--min-calls <n>").option("--max-calls <n>").option("--min-events <n>").option("--max-events <n>");
  trajectorySessionsCommand.command("nodes <key>").description("List session nodes").option("--offset <n>").option("--limit <n>").option("--revision <revision>").action(async (key: string, options: Options) => trajectorySessions(context(program), "nodes", key, options));
  trajectorySessionsCommand.command("node <key>").description("Inspect one session node").requiredOption("--kind <kind>").requiredOption("--id <id>").option("--start <n>").action(async (key: string, options: Options) => trajectorySessions(context(program), "node", key, options));
  const calls = trajectory.command("calls").description("Inspect trajectory calls");
  addTrajectoryOptions(calls.command("inspect <id>").description("Inspect a call")).action(async (id: string, options: Options) => trajectoryCalls(context(program), "inspect", id, options));
  addTrajectoryOptions(calls.command("diff <id>").description("Diff a call against another call")).action(async (id: string, options: Options) => trajectoryCalls(context(program), "diff", id, options));
  const snapshots = trajectory.command("snapshots").description("Manage trajectory snapshots");
  snapshots.command("list").description("List snapshots").option("--key <key>").option("--offset <n>").option("--limit <n>").action(async (options: Options) => trajectorySnapshots(context(program), "list", undefined, options));
  bodyOptions(snapshots.command("create").description("Create a snapshot")).requiredOption("--key <key>").requiredOption("--kind <kind>").requiredOption("--node-id <id>").option("--label <text>").option("--retention-days <n>").requiredOption("--confirm").action(async (options: Options) => trajectorySnapshots(context(program), "create", undefined, options));
  for (const action of ["inspect", "diff", "export", "delete"] as const) {
    const command = snapshots.command(`${action} <id>`).description(`${action} a snapshot`);
    if (action === "delete") command.requiredOption("--confirm");
    addTrajectoryOptions(command).action(async (id: string, options: Options) => trajectorySnapshots(context(program), action, id, options));
  }

  return program;
}
