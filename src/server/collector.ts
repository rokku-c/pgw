import { readdir, stat, realpath } from "node:fs/promises";
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { db, AssetSchema, record, audit } from "./store";
import { scanSessions } from "./sessions";
import { scanAssets } from "./assets";
import type { WorkContext } from "./job-context";
import type { Asset } from "../shared/types";

const roots = process.env.PGW_NATIVE_DISCOVERY==="0"?[]:[
  { id: "claude", name: "Claude Code", command: "claude", home: join(homedir(), ".claude"), sessions: "projects" },
  { id: "codex", name: "Codex", command: "codex", home: process.env.CODEX_HOME || join(homedir(), ".codex"), sessions: "sessions" },
  { id: "pi", name: "Pi", command: "pi", home: join(homedir(), ".pi/agent"), sessions: "sessions" },
] as const;
let scanning = false;
let work: WorkContext | undefined;
async function boundedText(stream:ReadableStream<Uint8Array>){
  const reader=stream.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>65536){await reader.cancel();throw new Error("version_output_limit");}chunks.push(next.value);}return Buffer.concat(chunks).toString("utf8");}finally{reader.releaseLock();}
}
async function upsertAsset(value: Omit<Asset, "id" | "createdAt" | "updatedAt">) {
  const repo = db.getRepository(AssetSchema);
  const previous = await repo.findOneBy({ path: value.path });
  await repo.save({ ...record(), ...previous, ...value, updatedAt: Date.now() });
}
async function scanSource(root: typeof roots[number], result: { skills: number; sessions: number; parsedEvents: number; mcp: number; limited: boolean; errors: string[] }) {
  const configPaths = root.id === "claude" ? [join(homedir(), ".claude.json"), join(root.home, "settings.json")] : root.id === "codex" ? [join(root.home, "config.toml")] : [join(root.home, "settings.json")];
  for (const path of configPaths) {
    try {
      if (!await Bun.file(path).exists()) continue;
      const raw = await Bun.file(path).text();
      const config = path.endsWith(".toml") ? Bun.TOML.parse(raw) : JSON.parse(raw);
      const servers = config.mcpServers ?? config.mcp_servers ?? {};
      for (const [name, item] of Object.entries(servers)) {
        const server = item as Record<string, unknown>;
        await upsertAsset({ kind: "mcp", name, source: root.id, path: `${path}#${name}`, version: null, hash: null, description: null, status: "discovered", metadata: { transport: server.url ? "http" : "stdio", configPath: path, command: typeof server.command === "string" ? basename(server.command) : null } });
        result.mcp++;
      }
    } catch { result.errors.push(path); }
  }
}
export async function scanRegistry(context?: WorkContext) {
  if (scanning) return { busy: true };
  scanning = true; work=context;
  const result = { busy: false, agents: 0, skills: 0, sessions: 0, parsedEvents: 0, mcp: 0, limited: false, errors: [] as string[] };
  try {
    for (const root of roots) {
      const executable = Bun.which(root.command);
      if (executable) {
        let version: string | null = null;
        try {
          const child = Bun.spawn([executable, "--version"], { cwd: homedir(), stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "1" } });
          const stop=()=>child.kill("SIGKILL");
          const timeout=setTimeout(stop,3000);context?.signal.addEventListener("abort",stop,{once:true});
          try { const [output] = await Promise.all([boundedText(child.stdout),boundedText(child.stderr),child.exited]); version = output.trim().slice(0,120)||null; }
          finally { clearTimeout(timeout);context?.signal.removeEventListener("abort",stop);if(child.exitCode===null)stop(); }
        } catch {}
        await upsertAsset({ kind: "agent", name: root.name, source: root.id, path: executable, version, hash: null, description: null, status: "available", metadata: { configHome: root.home } }); result.agents++;
      }
      await scanSource(root, result);
    }
    const skills = await scanAssets(undefined,context);result.skills=skills.skills;result.limited ||= skills.limited;
    const sessions = await scanSessions(undefined,context);
    result.sessions = sessions.files; result.parsedEvents = sessions.events; result.limited ||= sessions.limited;
    await audit("registry.scanned", "local", { ...result, errors: result.errors.length + sessions.errors });
    return result;
  } finally { scanning = false; work=undefined; }
}
