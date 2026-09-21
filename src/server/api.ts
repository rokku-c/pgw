import { z } from "zod";
import { db, ProviderSchema, RouteSchema, ClientSchema, TrafficSchema, PreferenceSchema, AssetSchema, SessionSchema, AuditSchema, record, audit, setting, saveSetting, RunSchema, McpSchema, RunEventSchema, ApprovalSchema, SourceSchema, McpCallSchema, McpRevisionSchema, JobSchema } from "./store";
import { ApiError, readJson, requireAdmin, encrypt, decrypt, hash, newClientKey, validProviderUrl, secureEqual, sessionCookie } from "./security";
import { adminToken, address, version, startedAt } from "./config";
import { probeProvider } from "./providers";
import { submitJob, jobDetail, cancelJob, retryJob, publicJob } from "./jobs";
import { debugInput,debugAttempts,debugAttemptDetail } from "./playground";
import { assetRoots,saveAssetRoot,listDeployments } from "./assets";
import { listRouteSessions, deleteRouteSession, resetCircuit } from "./routing";
import { scanRegistry } from "./collector";
import { listSources, saveSource, scanSessions, listSessions, timeline, forgetSession, resetSource, removeSource } from "./sessions";
import { savePreference, removePreference, preferenceHistory, restorePreference, addEventEvidence, habitTimeline, sourcePreference } from "./preferences";
import { startRun, stopRun, resumeRun, steerRun, completeRun, decideApproval } from "./runtime";
import { probeMcp, callMcp, executeMcp, validateGrants, decideMcpCall, cancelMcpCall, publicMcpCall, revokeMcpAccess } from "./mcp";
import { budgetSummary } from "./budget";
import { capturePolicy, configureCapture, inspectCapture, captureStage, deleteCapture, deleteAllCaptures, inspectTrajectory, compareTrajectory, trajectorySessions, trajectoryNodes, trajectoryNodeDetail, contextSnapshots, inspectContextSnapshot, compareContextSnapshots, deleteContextSnapshot } from "./observability";
import { adaptivePolicy, retryPolicy, protocolConversionEnabled } from "./context-management";
import type { Provider, ClientKey, Dashboard, McpConnection } from "../shared/types";

const name = z.string().trim().min(1).max(100);
const providerInput = z.object({ name, protocol: z.enum(["openai", "anthropic", "gemini"]), baseUrl: z.string().max(2048).transform((value, context) => { try { return validProviderUrl(value); } catch { context.addIssue({ code: "custom", message: "Invalid provider URL" }); return z.NEVER; } }), secret: z.string().max(8192).optional(), enabled: z.boolean().default(true) });
const routeInput = z.object({ alias: z.string().trim().regex(/^[\w.\-/:]{1,150}$/), protocol: z.enum(["responses", "chat", "messages", "gemini"]),
  strategy:z.enum(["priority","round_robin","least_active"]).default("priority"), targets: z.array(z.object({ providerId: z.string().uuid(), model: z.string().min(1).max(200), protocol:z.enum(["responses","chat","messages","gemini"]).optional(), weight:z.number().int().min(1).max(100).default(1),priority:z.number().int().min(0).max(100).default(0),maxConcurrent:z.number().int().min(1).max(100).optional() })).min(1).max(5),
  enabled: z.boolean().default(true), inputPrice: z.number().min(0).max(100000).refine(n => Number(n.toFixed(6)) === n).nullable().default(null), outputPrice: z.number().min(0).max(100000).refine(n => Number(n.toFixed(6)) === n).nullable().default(null),
  cacheReadPrice: z.number().min(0).max(100000).refine(n => Number(n.toFixed(6)) === n).nullable().default(null), cacheWritePrice: z.number().min(0).max(100000).refine(n => Number(n.toFixed(6)) === n).nullable().default(null), cacheWriteLongPrice: z.number().min(0).max(100000).refine(n => Number(n.toFixed(6)) === n).nullable().default(null),
  contextLimit: z.number().int().min(1000).max(4_000_000).default(128000), outputLimit: z.number().int().min(1).max(1_000_000).default(8192) });
const preferenceInput = z.object({ title: name, content: z.string().trim().min(1).max(3000), scope: z.enum(["global", "project"]),
  project: z.string().trim().max(500).nullable().default(null), status: z.enum(["candidate", "active", "paused"]).default("active") });
const grantInput = z.object({ connectionId: z.string().uuid(), schemaHash: z.string().length(64), tools: z.array(z.string().max(200)).max(2000).default([]), resources: z.array(z.string().max(4096)).max(2000).default([]), prompts: z.array(z.string().max(200)).max(2000).default([]), requireApproval: z.boolean().default(true) });
const clientInput = z.object({ name, kind: z.enum(["long_term", "temporary"]).default("long_term"), project: z.string().trim().max(500).nullable().default(null), personalize: z.boolean().default(false), routeIds: z.array(z.string().uuid()).max(200).default([]), budgetMicros: z.number().int().min(0).max(1e12).nullable().default(null), tokenLimit: z.number().int().min(1).max(1e12).nullable().default(null), maxConcurrent: z.number().int().min(1).max(32).default(4), expiresAt: z.number().int().min(Date.now()).nullable().default(null), mcpGrants: z.array(grantInput).max(40).default([]), memoryAccess: z.boolean().default(false) }).superRefine((input, context) => {
  if (input.kind === "temporary" && input.expiresAt === null) context.addIssue({ code: "custom", path: ["expiresAt"], message: "temporary_key_expiry_required" });
});
function publicProvider(p: Provider) { const { secretCipher, ...rest } = p; return { ...rest, hasSecret: !!secretCipher }; }
function publicClient(p: ClientKey) { const { keyHash, ...rest } = p; return rest; }
async function get<T extends object>(schema: any, id: string): Promise<any> {
  const item = await db.getRepository(schema).findOneBy({ id });
  if (!item) throw new ApiError(404, "not_found");
  return item;
}
export async function api(request: Request) {
  const url = new URL(request.url), path = url.pathname.replace(/^\/api/, ""), method = request.method;
  if (path === "/auth/session" && method === "POST") {
    const body = z.object({ token: z.string().max(200) }).parse(await readJson(request));
    if (!secureEqual(body.token, adminToken)) throw new ApiError(401, "invalid_token");
    return Response.json({ ok: true }, { headers: { "set-cookie": sessionCookie() } });
  }
  requireAdmin(request);
  if (path === "/auth/session" && method === "DELETE") return Response.json({ ok: true }, { headers: { "set-cookie": "pgw_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" } });
  if (path === "/status" && method === "GET") return Response.json({ version, uptime: Date.now() - startedAt, address, database: "sqlite", personalization: await setting("personalization", true), captureBodies: (await capturePolicy()).enabled });
  if (path === "/observability" && method === "GET") return Response.json(await capturePolicy());
  if (path === "/observability" && method === "PATCH") { const input = z.object({ enabled:z.boolean(), retentionDays:z.number().int().min(1).max(365), maxStageBytes:z.number().int().min(65536).max(16*1024*1024), maxStorageBytes:z.number().int().min(1024*1024).max(4*1024*1024*1024) }).parse(await readJson(request)); return Response.json(await configureCapture(input)); }
  if (path === "/observability/captures" && method === "DELETE") return Response.json(await deleteAllCaptures());
  if(path==="/observability/snapshots"&&method==="GET")return Response.json((await db.query("SELECT id,createdAt,updatedAt,label,hash,summary FROM observability_snapshots ORDER BY createdAt DESC LIMIT 100")).map((row:any)=>({...row,summary:JSON.parse(row.summary),legacy:true})));
  if(path.startsWith("/observability/snapshots")||path==="/observability/timeline")throw new ApiError(410,"snapshot_context_required");
  if (path === "/dashboard" && method === "GET") {
    const since = Date.now() - 86_400_000;
    const [counts] = await db.query(`SELECT count(*) as requests, sum(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
      sum(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      sum(coalesce(inputTokens, 0) + coalesce(outputTokens, 0)) as tokens,
      sum(coalesce(inputTokens, 0)) as inputTokens,sum(coalesce(outputTokens, 0)) as outputTokens,sum(coalesce(reasoningTokens, 0)) as reasoningTokens,
      sum(coalesce(cacheReadTokens, 0)) as cacheReadTokens,sum(coalesce(cacheWriteTokens, 0)) as cacheWriteTokens,
      sum(coalesce(costMicros, 0)) as costMicros, sum(CASE WHEN costMicros IS NULL THEN 1 ELSE 0 END) as unknownCost,
      avg(CASE WHEN status = 'completed' THEN latencyMs END) as latencyMs,avg(CASE WHEN status='completed' THEN firstTokenMs END) as avgFirstTokenMs,avg(CASE WHEN status='completed' THEN decodingMs END) as avgDecodingMs,
      sum(CASE WHEN instr(decisions,'"action":"retry"')>0 THEN 1 ELSE 0 END) as retries FROM traffic WHERE createdAt >= ?`, [since]);
    const latencyRows=await db.query("SELECT latencyMs FROM traffic WHERE createdAt>=? AND status='completed' AND latencyMs IS NOT NULL ORDER BY latencyMs",[since]) as {latencyMs:number}[];
    const p95LatencyMs=latencyRows.length?latencyRows[Math.min(latencyRows.length-1,Math.floor(latencyRows.length*.95))].latencyMs:null;
    const [toolCounts]=await db.query("SELECT count(*) n FROM mcp_calls WHERE createdAt>=?",[since]);
    const series = await db.query(`SELECT strftime('%Y-%m-%dT%H:00:00Z', createdAt / 1000, 'unixepoch') as hour, count(*) as count,
      sum(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed FROM traffic WHERE createdAt >= ? GROUP BY hour`, [since]);
    const output: Dashboard = { requests: counts.requests, running: counts.running || 0, successRate: counts.requests ? counts.completed / counts.requests : null,
      tokens: counts.tokens || 0, inputTokens: counts.inputTokens || 0, outputTokens: counts.outputTokens || 0, reasoningTokens: counts.reasoningTokens || 0, cacheReadTokens: counts.cacheReadTokens || 0, cacheWriteTokens: counts.cacheWriteTokens || 0, costMicros: counts.costMicros || 0, unknownCost: counts.unknownCost || 0, latencyMs: counts.latencyMs, avgFirstTokenMs: counts.avgFirstTokenMs, avgDecodingMs: counts.avgDecodingMs, p95LatencyMs, modelCalls: counts.requests || 0, toolCalls: toolCounts.n || 0, retries: counts.retries || 0,
      series, recent: await db.getRepository(TrafficSchema).find({ order: { createdAt: "DESC" }, take: 8 }),
      events: await db.getRepository(AuditSchema).find({ order: { createdAt: "DESC" }, take: 8 }),
      providers: await db.getRepository(ProviderSchema).countBy({ enabled: true }), agents: await db.getRepository(AssetSchema).countBy({ kind: "agent" }),
      skills: await db.getRepository(AssetSchema).countBy({ kind: "skill" }), mcp: await db.getRepository(AssetSchema).countBy({ kind: "mcp" }) + await db.getRepository(McpSchema).count(),
      sessions: await db.getRepository(SessionSchema).count(), preferences: await db.getRepository(PreferenceSchema).countBy({ status: "active" }) };
    return Response.json(output);
  }
  if (path === "/providers" && method === "GET") return Response.json((await db.getRepository(ProviderSchema).find({ order: { createdAt: "ASC" } })).map(publicProvider));
  const providerMatch = path.match(/^\/providers\/([^/]+)(\/probe)?$/);
  if (path === "/providers" && method === "POST" || providerMatch && method === "PATCH" && !providerMatch[2]) {
    const input = providerInput.parse(await readJson(request));
    const previous = providerMatch ? await get(ProviderSchema, providerMatch[1]) as Provider : null;
    const { secret, ...values } = input;
    const item = await db.getRepository(ProviderSchema).save({ ...record(), health: "unknown", latencyMs: null, lastChecked: null, lastError: null, secretCipher: null,
      ...previous, ...values, ...(secret !== undefined ? { secretCipher: secret ? encrypt(secret) : null } : {}), updatedAt: Date.now() });
    await audit(previous ? "provider.updated" : "provider.created", item.name);
    return Response.json(publicProvider(item));
  }
  if (providerMatch) {
    const provider = await get(ProviderSchema, providerMatch[1]) as Provider;
    if (providerMatch[2] && method === "POST") return Response.json({job:await submitJob("provider.probe",provider.name,{id:provider.id})},{status:202});
    if (!providerMatch[2] && method === "DELETE") {
      const routes = await db.getRepository(RouteSchema).find();
      if (routes.some(r => r.targets.some(t => t.providerId === provider.id))) throw new ApiError(409, "provider_in_use");
      await db.getRepository(ProviderSchema).delete(provider.id); await audit("provider.deleted", provider.name); return Response.json({ ok: true });
    }
  }
  if (path === "/routes" && method === "GET") return Response.json(await db.getRepository(RouteSchema).find({ order: { createdAt: "ASC" } }));
  const routeMatch = path.match(/^\/routes\/([^/]+)$/);
  if (path === "/routes" && method === "POST" || routeMatch && method === "PATCH") {
    const input = routeInput.parse(await readJson(request));
    for (const target of input.targets) {
      const provider = await get(ProviderSchema, target.providerId) as Provider;
      if (target.protocol && provider.protocol !== (target.protocol === "messages" ? "anthropic" : target.protocol === "gemini" ? "gemini" : "openai")) throw new ApiError(400, "protocol_mismatch");
    }
    const previous = routeMatch ? await get(RouteSchema, routeMatch[1]) : null;
    const duplicate = await db.getRepository(RouteSchema).findOneBy({ alias: input.alias });
    if (duplicate && duplicate.id !== previous?.id) throw new ApiError(409, "alias_exists");
    const item = await db.getRepository(RouteSchema).save({ ...record(), ...previous, ...input, updatedAt: Date.now() });
    await audit(previous ? "route.updated" : "route.created", item.alias); return Response.json(item);
  }
  if (routeMatch && method === "DELETE") { const item = await get(RouteSchema, routeMatch[1]); await db.getRepository(RouteSchema).delete(item.id); await audit("route.deleted", item.alias); return Response.json({ ok: true }); }
  if (path === "/clients" && method === "GET") return Response.json((await db.getRepository(ClientSchema).find({ order: { createdAt: "DESC" } })).map(publicClient));
  if (path === "/clients" && method === "POST") {
    const input = clientInput.parse(await readJson(request));
    for (const id of input.routeIds) await get(RouteSchema, id);
    await validateGrants(input.mcpGrants);
    const key = newClientKey();
    const item = await db.getRepository(ClientSchema).save({ ...record(), ...input, enabled: true, keyHash: hash(key), keyPreview: `${key.slice(0, 8)}…${key.slice(-4)}`, lastUsedAt: null, runId: null });
    await audit("client.created", item.name); return Response.json({ ...publicClient(item), key });
  }
  const clientBudget = path.match(/^\/clients\/([^/]+)\/budget$/);
  if (clientBudget && method === "GET") { await get(ClientSchema, clientBudget[1]); return Response.json(await budgetSummary("client", clientBudget[1])); }
  const clientMatch = path.match(/^\/clients\/([^/]+)$/);
  if (clientMatch && method === "PATCH") {
    const input = z.object({ mcpGrants: z.array(grantInput).max(40), memoryAccess: z.boolean() }).parse(await readJson(request));
    const client = await get(ClientSchema, clientMatch[1]) as ClientKey;
    await validateGrants(input.mcpGrants);
    await db.getRepository(ClientSchema).save({ ...client, ...input, updatedAt: Date.now() });
    await revokeMcpAccess({ clientId: client.id });
    await audit("client.mcp_access_updated", client.id);
    return Response.json(publicClient({ ...client, ...input }));
  }
  if (clientMatch && method === "DELETE") { const item = await get(ClientSchema, clientMatch[1]); await revokeMcpAccess({ clientId: item.id }); await db.getRepository(ClientSchema).delete(item.id); await audit("client.revoked", item.name); return Response.json({ ok: true }); }
  if (path === "/preferences" && method === "GET") return Response.json(await db.getRepository(PreferenceSchema).find({ order: { updatedAt: "DESC" } }));
  if (path === "/preferences/from-event" && method === "POST") {
    const input = z.object({ eventId: z.string().min(1).max(100), title: z.string().max(100).optional(), scope: z.enum(["global", "project"]) }).parse(await readJson(request));
    return Response.json(await sourcePreference(input));
  }
  const prefMatch = path.match(/^\/preferences\/([^/]+)$/);
  if (path === "/preferences" && method === "POST" || prefMatch && method === "PATCH") {
    const input = preferenceInput.parse(await readJson(request));
    if (input.scope === "project" && !input.project) throw new ApiError(400, "project_required");
    return Response.json(await savePreference(input, prefMatch?.[1]));
  }
  if (prefMatch && method === "DELETE") return Response.json(await removePreference(prefMatch[1]));
  if (path === "/preferences/timeline" && method === "GET") return Response.json(await habitTimeline());
  const preferenceDetail = path.match(/^\/preferences\/([^/]+)\/(history|restore|evidence)$/);
  if (preferenceDetail) {
    if (method === "GET" && preferenceDetail[2] === "history") return Response.json(await preferenceHistory(preferenceDetail[1]));
    if (method === "POST" && preferenceDetail[2] === "restore") { const body = z.object({ revision: z.number().int().positive() }).parse(await readJson(request)); return Response.json(await restorePreference(preferenceDetail[1], body.revision)); }
    if (method === "POST" && preferenceDetail[2] === "evidence") { const body = z.object({ eventId: z.string().max(100), kind: z.enum(["explicit", "correction", "counterexample"]) }).parse(await readJson(request)); return Response.json(await addEventEvidence(preferenceDetail[1], body.eventId, body.kind)); }
  }
  if (path === "/routing/sessions" && method === "GET") return Response.json(await listRouteSessions());
  if (path === "/routing/circuits" && method === "GET") return Response.json(await db.query('SELECT c.*,p.name providerName FROM provider_circuits c LEFT JOIN providers p ON p.id=c.providerId ORDER BY c.updatedAt DESC LIMIT 200'));
  const routeSession = path.match(/^\/routing\/sessions\/([^/]+)$/);
  if (routeSession && method === "DELETE") return Response.json(await deleteRouteSession(routeSession[1]));
  const circuit = path.match(/^\/routing\/circuits\/([^/]+)\/reset$/);
  if (circuit && method === "POST") return Response.json(await resetCircuit(circuit[1]));
  if(path==="/trajectory/snapshots"&&method==="POST"){
    const input=z.object({key:z.string().regex(/^(scanned|managed|external|route|call):[a-zA-Z0-9-]{1,100}$/),kind:z.enum(["traffic","session_event","run_event","approval","mcp_call"]),nodeId:z.string().min(1).max(100),label:z.string().trim().max(160).optional(),retentionDays:z.number().int().min(1).max(365).default(7),confirmed:z.literal(true)}).parse(await readJson(request));
    return Response.json({job:await submitJob("trajectory.snapshot","trajectory.snapshot",input)},{status:202});
  }
  if(path==="/trajectory/snapshots"&&method==="GET"){
    const input=z.object({key:z.string().min(1).max(160),offset:z.coerce.number().int().min(0).max(1000000).default(0),limit:z.coerce.number().int().min(1).max(100).default(30)}).parse(Object.fromEntries(url.searchParams));
    return Response.json(await contextSnapshots(input,request.signal));
  }
  const contextSnapshot=path.match(/^\/trajectory\/snapshots\/([^/]+)(?:\/(inspect|diff|export))?$/);
  if(contextSnapshot){
    const id=z.string().uuid().parse(contextSnapshot[1]);
    if(method==="DELETE"&&!contextSnapshot[2])return Response.json(await deleteContextSnapshot(id));
    if(method==="GET"&&["inspect","diff","export"].includes(contextSnapshot[2])){
      const input=z.object({stage:z.enum(["request","effective","upstream","response","output","node"]).optional(),format:z.enum(["structured","raw","manifest"]).optional(),offset:z.coerce.number().int().min(0).max(1000000).default(0),limit:z.coerce.number().int().min(1).max(50).default(25),section:z.enum(["system","messages","tools","config","transport","output","other"]).optional(),block:z.string().max(400).optional(),start:z.coerce.number().int().min(0).max(128*1024*1024).default(0),against:z.string().uuid().optional(),change:z.coerce.number().int().min(0).max(1000000).optional(),side:z.enum(["before","after"]).optional()}).parse(Object.fromEntries(url.searchParams));
      if(contextSnapshot[2]==="inspect")return Response.json(await inspectContextSnapshot({id,...input},request.signal));
      if(contextSnapshot[2]==="diff"){
        if(!input.against)throw new ApiError(400,"snapshot_compare_required");
        return Response.json(await compareContextSnapshots({before:input.against,after:id,...input},request.signal));
      }
      const first:any=await inspectContextSnapshot({id,stage:input.stage,format:"raw",start:0},request.signal);
      let page:any=first,ended=false;
      return new Response(new ReadableStream({async pull(controller){
        try{if(ended){controller.close();return;}controller.enqueue(new TextEncoder().encode(page.text));if(page.next===null){ended=true;return;}page=await inspectContextSnapshot({id,stage:input.stage,format:"raw",start:page.next},request.signal);}catch(error){controller.error(error);}
      }}),{headers:{"content-type":"text/plain; charset=utf-8","content-disposition":`attachment; filename="snapshot-${id}-${input.stage||"body"}.txt"`}});
    }
  }
  if(path==="/trajectory/sessions"&&method==="GET"){
    const input=z.object({kind:z.enum(["scanned","managed","independent"]).optional(),query:z.string().max(300).optional(),cursor:z.string().max(3000).optional(),limit:z.coerce.number().int().min(1).max(100).default(40),minCalls:z.coerce.number().int().min(0).max(1000000).default(0),maxCalls:z.coerce.number().int().min(0).max(1000000).optional(),minEvents:z.coerce.number().int().min(0).max(1000000).default(0),maxEvents:z.coerce.number().int().min(0).max(1000000).optional()}).parse(Object.fromEntries(url.searchParams));
    return Response.json(await trajectorySessions(input,request.signal));
  }
  const trajectorySession=path.match(/^\/trajectory\/sessions\/([^/]+)\/(nodes|node)$/);
  if(trajectorySession&&method==="GET"){
    const key=decodeURIComponent(trajectorySession[1]);
    if(!/^(scanned|managed|external|route|call):[a-zA-Z0-9-]{1,100}$/.test(key))throw new ApiError(400,"invalid_session_key");
    if(trajectorySession[2]==="nodes"){
      const input=z.object({offset:z.coerce.number().int().min(0).max(10000000).default(0),limit:z.coerce.number().int().min(1).max(100).default(40),revision:z.string().max(500).optional()}).parse(Object.fromEntries(url.searchParams));
      return Response.json(await trajectoryNodes({key,...input},request.signal));
    }
    const input=z.object({kind:z.enum(["traffic","session_event","run_event","approval","mcp_call"]),id:z.string().min(1).max(100),start:z.coerce.number().int().min(0).max(64*1024*1024).default(0)}).parse(Object.fromEntries(url.searchParams));
    return Response.json(await trajectoryNodeDetail({key,...input},request.signal));
  }
  const trajectoryCall=path.match(/^\/trajectory\/calls\/([^/]+)\/(inspect|diff)$/);
  if(trajectoryCall&&method==="GET"){
    const item=await get(TrafficSchema,trajectoryCall[1]);
    const input=z.object({stage:z.enum(["request","effective","upstream","response","output"]).default("effective"),offset:z.coerce.number().int().min(0).max(1000000).default(0),limit:z.coerce.number().int().min(1).max(50).default(30),section:z.enum(["system","messages","tools","config","transport","output","other"]).optional(),block:z.string().max(400).optional(),start:z.coerce.number().int().min(0).max(64*1024*1024).optional(),against:z.string().uuid().optional()}).parse(Object.fromEntries(url.searchParams));
    if(trajectoryCall[2]==="inspect")return Response.json(await inspectTrajectory({id:item.id,...input},request.signal));
    if(!input.against)throw new ApiError(400,"snapshot_compare_required");
    await get(TrafficSchema,input.against);
    return Response.json(await compareTrajectory({before:input.against,after:item.id,...input},request.signal));
  }
  const captureDetail = path.match(/^\/traffic\/([^/]+)\/capture(?:\/(request|effective|upstream|response|output))?$/);
  if (captureDetail) {
    const item = await get(TrafficSchema, captureDetail[1]);
    if (method === "DELETE" && !captureDetail[2]) return Response.json(await deleteCapture(item.id));
    if (method === "GET" && captureDetail[2]) return Response.json(await captureStage(item.id, captureDetail[2] as any, Number(url.searchParams.get("after") || -1)));
    if (method === "GET" && !captureDetail[2]) return Response.json(await inspectCapture(item.id));
  }
  const trafficDetail = path.match(/^\/traffic\/([^/]+)$/);
  if (trafficDetail && method === "GET") {
    const item = await get(TrafficSchema, trafficDetail[1]);
    const attempts = item.requestGroupId ? await db.getRepository(TrafficSchema).find({ where: { requestGroupId: item.requestGroupId }, order: { createdAt: "ASC" } }) : [item];
    const capture = await inspectCapture(item.id).catch(error => error instanceof ApiError && error.status === 404 ? null : Promise.reject(error));
    const sessionRequests = item.affinityId ? await db.getRepository(TrafficSchema).find({ where: { affinityId: item.affinityId }, order: { createdAt: "ASC" }, take: 100 }) : [];
    return Response.json({ request: item, attempts, capture, sessionRequests });
  }
  if (path === "/traffic" && method === "GET") return Response.json(await db.getRepository(TrafficSchema).find({ order: { createdAt: "DESC" }, take: 200 }));
  if(path==="/asset-roots"&&method==="GET")return Response.json(await assetRoots());
  const assetRoot=path.match(/^\/asset-roots\/([^/]+)(?:\/(scan))?$/);
  if(path==="/asset-roots"&&method==="POST"||assetRoot&&!assetRoot[2]&&method==="PATCH"){
    const input=z.object({name,agent:z.enum(["claude","codex","pi","shared"]),path:z.string().min(1).max(4096),project:z.string().max(4096).nullable().default(null),enabled:z.boolean().default(true),followSymlinks:z.boolean().default(false),capture:z.boolean().default(false),revision:z.number().int().positive().optional()}).parse(await readJson(request));
    return Response.json(await saveAssetRoot(input,assetRoot?.[1],input.revision));
  }
  if(assetRoot&&assetRoot[2]==="scan"&&method==="POST")return Response.json({job:await submitJob("assets.scan","Scan skills",{rootId:assetRoot[1]})},{status:202});
  if(path==="/skills"&&method==="GET"){
    const input=z.object({query:z.string().max(200).optional(),offset:z.coerce.number().int().min(0).default(0),limit:z.coerce.number().int().min(1).max(100).default(40),rootId:z.string().uuid().optional(),duplicates:z.enum(["true","false"]).optional()}).parse(Object.fromEntries(url.searchParams));
    return Response.json({job:await submitJob("assets.search","Search skills",{...input,duplicates:input.duplicates==="true"},false)},{status:202});
  }
  const assetDetail=path.match(/^\/assets\/([^/]+)(?:\/(snapshot|deploy))?$/);
  if(assetDetail){
    if(method==="GET"&&!assetDetail[2])return Response.json({job:await submitJob("assets.inspect","Read skill",{id:assetDetail[1]})},{status:202});
    if(method==="POST"&&assetDetail[2]==="snapshot"){z.object({confirmed:z.literal(true)}).parse(await readJson(request));return Response.json({job:await submitJob("assets.snapshot","Snapshot skill",{id:assetDetail[1]})},{status:202});}
    if(method==="POST"&&assetDetail[2]==="deploy"){
      const input=z.object({snapshotId:z.string().uuid(),targetRoot:z.string().min(1).max(4096),name:z.string().min(1).max(100),agent:z.enum(["claude","codex","pi","shared"])}).parse(await readJson(request));
      return Response.json({job:await submitJob("assets.preview","Preview installation",{...input,assetId:assetDetail[1]},false)},{status:202});
    }
  }
  const snapshot=path.match(/^\/asset-snapshots\/([^/]+)$/);
  if(snapshot&&method==="GET")return Response.json({job:await submitJob("assets.inspect","Read snapshot",{snapshotId:snapshot[1]})},{status:202});
  if(path==="/asset-deployments"&&method==="GET")return Response.json(await listDeployments());
  const deployment=path.match(/^\/asset-deployments\/([^/]+)\/(apply|restore)$/);
  if(deployment&&method==="POST"){z.object({confirmed:z.literal(true)}).parse(await readJson(request));return Response.json({job:await submitJob(deployment[2]==="apply"?"assets.apply":"assets.restore",deployment[2]==="apply"?"Install skill":"Restore installation",{id:deployment[1]},false)},{status:202});}
  if (path === "/assets" && method === "GET") return Response.json(await db.getRepository(AssetSchema).find({ order: { kind: "ASC", name: "ASC" } }));
  if (path === "/registry/scan" && method === "POST") return Response.json({job:await submitJob("registry.scan","扫描资产",{})},{status:202});
  if (path === "/sources" && method === "GET") return Response.json(await listSources());
  const sourceMatch = path.match(/^\/sources\/([^/]+)(?:\/(scan|restore-deleted))?$/);
  if (path === "/sources" && method === "POST" || sourceMatch && !sourceMatch[2] && method === "PATCH") {
    const input = z.object({ name, agent: z.enum(["claude", "codex", "pi", "auto"]), path: z.string().min(1).max(4096), enabled: z.boolean(), captureBodies: z.boolean(), learn: z.boolean(), revision: z.number().int().positive().optional() }).parse(await readJson(request));
    return Response.json(await saveSource(input, sourceMatch?.[1], input.revision));
  }
  if (sourceMatch && !sourceMatch[2] && method === "DELETE") return Response.json(await removeSource(sourceMatch[1]));
  if (sourceMatch && method === "POST") {
    await get(SourceSchema, sourceMatch[1]);
    if (sourceMatch[2] === "scan") return Response.json({job:await submitJob("sessions.scan","索引会话",{sourceId:sourceMatch[1]})},{status:202});
    if (sourceMatch[2] === "restore-deleted") return Response.json(await resetSource(sourceMatch[1]));
  }
  if (path === "/sessions" && method === "GET") {
    if (!url.searchParams.has("paged")) return Response.json((await listSessions({ limit: 200 })).items);
    const input = z.object({ query: z.string().max(200).optional(), agent: z.enum(["claude", "codex", "pi", "auto"]).optional(), project: z.string().max(4096).optional(), sourceId: z.string().max(100).optional(), offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(200).default(50), archived: z.enum(["true", "false"]).optional(), starred: z.enum(["true", "false"]).optional() }).parse(Object.fromEntries(url.searchParams));
    return Response.json({job:await submitJob("sessions.search","搜索会话",{ ...input, archived: input.archived === undefined ? undefined : input.archived === "true", starred: input.starred === "true" },false)},{status:202});
  }
  const sessionMatch = path.match(/^\/sessions\/([^/]+)(?:\/(timeline|export))?$/);
  if (sessionMatch) {
    if (method === "DELETE" && !sessionMatch[2]) return Response.json(await forgetSession(sessionMatch[1]));
    if (method === "PATCH" && !sessionMatch[2]) {
      const input = z.object({ starred: z.boolean().optional(), archived: z.boolean().optional(), tags: z.array(z.string().trim().min(1).max(40)).max(20).optional() }).parse(await readJson(request));
      const session = await get(SessionSchema, sessionMatch[1]); await db.getRepository(SessionSchema).update(session.id, { ...input, updatedAt: Date.now() }); return Response.json({ ...session, ...input });
    }
    if (method === "GET") {
      const input = z.object({ after: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(200).default(100), query: z.string().max(200).optional(), leaf: z.string().max(200).optional() }).parse(Object.fromEntries(url.searchParams));
      if (sessionMatch[2] === "timeline") return Response.json({job:await submitJob("sessions.timeline","读取会话",{id:sessionMatch[1],options:input},false)},{status:202});
      const result = await timeline(sessionMatch[1], input);
      if (sessionMatch[2] === "export") {
        let page: typeof result | undefined = result, cursor = result.next, ended = false;
        const encoder = new TextEncoder();
        return new Response(new ReadableStream({
          async pull(controller) {
            try {
              if (ended) { controller.close(); return; }
              const next = page ?? await timeline(sessionMatch[1], { ...input, after: cursor ?? undefined });
              if (next.session.generation !== result.session.generation) throw new Error("Session changed during export");
              controller.enqueue(encoder.encode(next.events.map(e => JSON.stringify(e)).join("\n") + (next.events.length ? "\n" : "")));
              cursor = next.next; page = undefined; ended = cursor === null;
              if (ended) controller.close();
            } catch (error) { controller.error(error); }
          },
          cancel() { ended = true; },
        }), { headers: { "content-type": "application/x-ndjson", "content-disposition": `attachment; filename="session-${result.session.id}.jsonl"` } });
      }
      return Response.json({ ...result, messages: result.events.filter(e => e.text && ["user", "assistant"].includes(e.role)).map(e => ({ role: e.role, text: e.text })), partial: result.next !== null || result.session.status !== "indexed" });
    }
  }
  if (path === "/settings" && method === "GET") return Response.json({ personalization: await setting("personalization", true), observability: await capturePolicy(), adaptiveContext: await adaptivePolicy(), protocolConversion: await protocolConversionEnabled(), transparentRetry: await retryPolicy() });
  if (path === "/settings" && method === "PATCH") {
    const input = z.object({ personalization: z.boolean().optional(), observability: z.object({ enabled:z.boolean(), retentionDays:z.number().int().min(1).max(365), maxStageBytes:z.number().int().min(65536).max(16*1024*1024), maxStorageBytes:z.number().int().min(1024*1024).max(4*1024*1024*1024) }).optional(), adaptiveContext: z.object({enabled:z.boolean(),learn:z.boolean(),compressionEnabled:z.boolean(),compressionRatio:z.number().min(.5).max(1),maxTokens:z.number().int().min(256).max(4_000_000).nullable(),awarenessPrompt:z.string().max(4000)}).optional(), protocolConversion:z.boolean().optional(), transparentRetry:z.object({enabled:z.boolean(),maxRetries:z.number().int().min(0).max(100),backoffMs:z.number().int().min(0).max(60000),statuses:z.array(z.number().int().min(400).max(599)).max(30)}).optional() }).refine(value => Object.values(value).some(item => item !== undefined)).parse(await readJson(request));
    if(input.personalization !== undefined) await saveSetting("personalization", input.personalization);
    if(input.observability) await configureCapture(input.observability);
    if(input.adaptiveContext) await saveSetting("adaptiveContext", input.adaptiveContext);
    if(input.protocolConversion !== undefined) await saveSetting("protocolConversion", input.protocolConversion);
    if(input.transparentRetry) await saveSetting("transparentRetry", input.transparentRetry);
    await audit("settings.updated", "settings", input); return Response.json({ personalization: await setting("personalization", true), observability: await capturePolicy(), adaptiveContext: await adaptivePolicy(), protocolConversion: await protocolConversionEnabled(), transparentRetry: await retryPolicy() });
  }
  const publicMcp = (item: McpConnection) => { const { envCipher, headersCipher, ...rest } = item; return { ...rest, hasEnv: !!envCipher, hasHeaders: !!headersCipher }; };
  if (path === "/mcp" && method === "GET") return Response.json((await db.getRepository(McpSchema).find({ order: { createdAt: "DESC" } })).map(publicMcp));
  if (path === "/mcp" && method === "POST") {
    const input = z.object({ name, transport: z.enum(["stdio", "http"]), url: z.string().url().optional(), command: z.string().max(1000).optional(), args: z.array(z.string().max(2000)).max(100).default([]), env: z.record(z.string(), z.string()).optional(), headers: z.record(z.string(), z.string()).optional() }).parse(await readJson(request));
    if (input.transport === "http") {
      if (!input.url) throw new ApiError(400, "invalid_url");
      const endpoint = new URL(input.url);
      if (!["https:", "http:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new ApiError(400, "invalid_url");
      if (endpoint.origin === address && endpoint.pathname === "/mcp") throw new ApiError(400, "mcp_self_connection");
    }
    if (input.transport === "stdio" && !input.command) throw new ApiError(400, "command_required");
    const item = await db.getRepository(McpSchema).save({ ...record(), name: input.name, transport: input.transport, url: input.url || null, command: input.command || null, args: input.args,
      envCipher: input.env ? encrypt(JSON.stringify(input.env)) : null, headersCipher: input.headers ? encrypt(JSON.stringify(input.headers)) : null, enabled: true, status: "unknown", version: null, tools: [], capabilities: {}, schemaHash: null, previousSchemaHash: null, lastChecked: null, lastError: null });
    await audit("mcp.created", item.name); return Response.json(publicMcp(item));
  }
  const mcpMatch = path.match(/^\/mcp\/([^/]+)(?:\/(probe|call|resource|prompt|history))?$/);
  if (mcpMatch) {
    const item = await get(McpSchema, mcpMatch[1]) as McpConnection;
    if (method === "POST" && mcpMatch[2] === "probe") return Response.json({job:await submitJob("mcp.probe",item.name,{id:item.id})},{status:202});
    if (method === "GET" && mcpMatch[2] === "history") return Response.json(await db.getRepository(McpRevisionSchema).find({ where: { connectionId: item.id }, order: { createdAt: "DESC" }, take: 50 }));
    if (method === "PATCH" && !mcpMatch[2]) {
      const input = z.object({ enabled: z.boolean() }).parse(await readJson(request));
      await db.getRepository(McpSchema).update(item.id, { enabled: input.enabled, updatedAt: Date.now() });
      if (!input.enabled) await revokeMcpAccess({ connectionId: item.id });
      await audit("mcp.enabled_changed", item.id, input); return Response.json({ ok: true });
    }
    if (method === "POST" && ["call", "resource", "prompt"].includes(mcpMatch[2])) {
      const input = z.object({ name: z.string().min(1).max(4096), arguments: z.record(z.string(), z.unknown()).default({}), confirmed: z.literal(true) }).parse(await readJson(request));
      return Response.json({job:await submitJob("mcp.debug",`${item.name} / ${input.name}`,{id:item.id,kind:mcpMatch[2] === "call" ? "tool" : mcpMatch[2] === "resource" ? "resource" : "prompt",name:input.name,arguments:input.arguments},false)},{status:202});
    }
    if (method === "DELETE" && !mcpMatch[2]) { await revokeMcpAccess({ connectionId: item.id }); await db.getRepository(McpSchema).delete(item.id); await audit("mcp.deleted", item.id); return Response.json({ ok: true }); }
  }
  if (path === "/mcp-calls" && method === "GET") {
    const status = url.searchParams.get("status");
    if (status && !["pending", "approved", "running", "completed", "rejected", "cancelled", "failed", "uncertain"].includes(status)) throw new ApiError(400, "invalid_status");
    const calls = await db.getRepository(McpCallSchema).find({ where: status ? { status: status as any } : {}, order: { createdAt: "DESC" }, take: 200 });
    return Response.json(calls.map(publicMcpCall));
  }
  const callMatch = path.match(/^\/mcp-calls\/([^/]+)(?:\/(decide|cancel))?$/);
  if (callMatch) {
    if (method === "POST" && callMatch[2] === "decide") { const input = z.object({ accept: z.boolean() }).parse(await readJson(request)); return Response.json(await decideMcpCall(callMatch[1], input.accept)); }
    if (method === "POST" && callMatch[2] === "cancel") return Response.json(await cancelMcpCall(callMatch[1]));
    if (method === "GET" && !callMatch[2]) { const call = await get(McpCallSchema, callMatch[1]); return Response.json({ ...publicMcpCall(call), arguments: JSON.parse(decrypt(call.requestCipher)), result: call.resultCipher ? JSON.parse(decrypt(call.resultCipher)) : null }); }
  }
  if (path === "/runs" && method === "GET") return Response.json(await db.getRepository(RunSchema).find({ order: { createdAt: "DESC" }, take: 100 }));
  if (path === "/runs" && method === "POST") {
    const input = z.object({ agent: z.enum(["codex", "claude", "pi"]), goal: z.string().trim().min(1).max(20000), workspace: z.string().min(1).max(1000), routeId: z.string().uuid(), timeoutSeconds: z.number().int().min(10).max(86400).default(600),
      controls: z.object({ mode: z.enum(["turn", "goal"]).default("turn"), maxTurns: z.number().int().min(1).max(1000).default(20), maxNoProgress: z.number().int().min(1).max(20).default(3),
        budgetMicros: z.number().int().min(0).max(1e12).nullable().default(null), tokenLimit: z.number().int().min(1).max(1e12).nullable().default(null), permission: z.enum(["read-only", "workspace-write"]).default("read-only"),
        mcpGrants: z.array(grantInput).max(40).default([]), memoryAccess: z.boolean().default(false), completionFiles: z.array(z.object({ path: z.string().min(1).max(1000), contains: z.string().max(10000).optional() })).max(30).default([]),
      }).optional(),
    }).parse(await readJson(request));
    return Response.json(await startRun(input));
  }
  const runMatch = path.match(/^\/runs\/([^/]+)(?:\/(stop|pause|resume|steer|complete|events|budget))?$/);
  if (runMatch) {
    const run = await get(RunSchema, runMatch[1]);
    const action = runMatch[2];
    if (method === "GET" && !action) return Response.json(run);
    if (method === "GET" && action === "events") return Response.json(await db.getRepository(RunEventSchema).find({ where: { runId: run.id }, order: { createdAt: "ASC" }, take: 1000 }));
    if (method === "GET" && action === "budget") return Response.json(await budgetSummary("run", run.id));
    if (method === "POST" && (action === "stop" || action === "pause")) return Response.json(await stopRun(run.id, action === "pause"));
    if (method === "POST" && action === "resume") {
      const input = z.object({ message: z.string().max(20000).optional(), extraTurns: z.number().int().min(1).max(1000).optional(), extraSeconds: z.number().int().min(1).max(86400).optional(), budgetMicros: z.number().int().min(0).max(1e12).optional(), tokenLimit: z.number().int().min(1).max(1e12).optional() }).parse(await readJson(request));
      return Response.json(await resumeRun(run.id, input));
    }
    if (method === "POST" && action === "steer") { const input = z.object({ message: z.string().trim().min(1).max(20000) }).parse(await readJson(request)); return Response.json(await steerRun(run.id, input.message)); }
    if (method === "POST" && action === "complete") return Response.json(await completeRun(run.id));
  }
  if (path === "/approvals" && method === "GET") return Response.json(await db.getRepository(ApprovalSchema).find({ where: { status: "pending" }, order: { createdAt: "ASC" }, take: 100 }));
  const approvalMatch = path.match(/^\/approvals\/([^/]+)$/);
  if (approvalMatch && method === "POST") {
    const input = z.object({ accept: z.boolean().optional(), answers: z.record(z.string(), z.array(z.string().max(10000)).max(10)).optional(), value: z.string().max(10000).optional() }).refine(v => v.accept !== undefined || v.answers !== undefined || v.value !== undefined).parse(await readJson(request));
    return Response.json(await decideApproval(approvalMatch[1], input));
  }
  if(path==="/jobs"&&method==="GET")return Response.json((await db.query("SELECT id,createdAt,updatedAt,kind,label,status,phase,processed,total,currentItem,attempts,nextRunAt,startedAt,endedAt,heartbeatAt,cancelRequested,error FROM background_jobs ORDER BY createdAt DESC LIMIT 100")));
  if(path==="/debug/model"&&method==="POST") {const input=debugInput.parse(await readJson(request,2*1024*1024));return Response.json({job:await submitJob("model.debug","模型调试",input,false)},{status:202});}
  const attemptMatch=path.match(/^\/jobs\/([^/]+)\/attempts(?:\/([^/]+))?$/);
  if(attemptMatch&&method==="GET")return Response.json(attemptMatch[2]?await debugAttemptDetail(attemptMatch[1],attemptMatch[2]):await debugAttempts(attemptMatch[1]));
  const jobMatch=path.match(/^\/jobs\/([^/]+)(?:\/(cancel|retry))?$/);
  if(jobMatch){
    if(method==="GET"&&!jobMatch[2])return Response.json(await jobDetail(jobMatch[1]));
    if(method==="POST"&&jobMatch[2]==="cancel")return Response.json(await cancelJob(jobMatch[1]));
    if(method==="POST"&&jobMatch[2]==="retry"){const input=z.object({confirmed:z.boolean().default(false)}).parse(await readJson(request));return Response.json({job:await retryJob(jobMatch[1],input.confirmed)},{status:202});}
  }
  if (path === "/inventory" && method === "GET") return Response.json({ version: 1, exportedAt: new Date().toISOString(),
    providers: (await db.getRepository(ProviderSchema).find()).map(publicProvider), routes: await db.getRepository(RouteSchema).find(), assets: await db.getRepository(AssetSchema).find() });
  throw new ApiError(404, "not_found");
}
