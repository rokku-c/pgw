import { Database } from "bun:sqlite";
import { join } from "node:path";
import { home } from "./config";
import { ApiError } from "./security";
import type { TrajectoryEvidence, TrajectorySession, TrajectorySessionPage, TrajectoryNode, TrajectoryNodePage } from "../shared/trajectory";

let connection: Database | undefined;
function sql() {
  if (!connection) { connection = new Database(join(home, "gateway.sqlite"), { readonly: true, strict: true }); connection.run("PRAGMA busy_timeout=1000"); }
  return connection;
}
const catalog = `WITH calls AS (
  SELECT t.*,coalesce(c.sessionKey,CASE WHEN t.runId IS NOT NULL THEN 'managed:'||t.runId WHEN t.affinityId IS NOT NULL THEN 'route:'||t.affinityId ELSE 'call:'||coalesce(t.requestGroupId,t.id) END) sessionKey,
  c.agent,c.nativeSessionId,c.nativeTurnId,c.stepId,c.turnNumber,coalesce(c.evidence,'legacy_traffic') evidence,coalesce(c.ownerKey,'client:'||t.clientId) ownerKey,coalesce(c.project,t.project) workspace
  FROM traffic t LEFT JOIN trajectory_call_context c ON c.requestId=t.id
), catalog AS (
  SELECT 'scanned:'||s.id key,'scanned' kind,s.title,s.agent,s.nativeId,s.project,CASE WHEN cs.id IS NULL OR cs.enabled=0 THEN 'restricted' ELSE s.status END status,s.lastActiveAt at,s.sourceId,s.parentSessionId parentId,0 calls,s.eventCount events,'source:'||coalesce(s.sourceId,s.id) scope,'native_session_file' evidence FROM sessions s LEFT JOIN collection_sources cs ON cs.id=s.sourceId
  UNION ALL
  SELECT 'managed:'||r.id,'managed',r.goal,r.agent,r.nativeSessionId,r.workspace,r.status,r.updatedAt,NULL,NULL,(SELECT count(*) FROM traffic t WHERE t.runId=r.id),(SELECT count(*) FROM run_events e WHERE e.runId=r.id),'run:'||r.id,'managed_run' FROM runs r
  UNION ALL
  SELECT c.sessionKey,'independent',max(c.clientName)||' · '||max(c.model),max(c.agent),max(c.nativeSessionId),max(c.workspace),CASE WHEN sum(c.status='running')>0 THEN 'running' WHEN sum(c.status='failed')>0 THEN 'failed' ELSE 'completed' END,max(c.createdAt),NULL,NULL,count(*),count(*),max(c.ownerKey),max(c.evidence)
  FROM calls c WHERE c.runId IS NULL OR NOT EXISTS(SELECT 1 FROM runs r WHERE r.id=c.runId) GROUP BY c.sessionKey
  UNION ALL
  SELECT m.sessionKey,'independent',max(m.clientName)||' · MCP / '||max(m.name),NULL,max(m.nativeSessionId),max(m.project),CASE WHEN sum(m.status='running')>0 THEN 'running' ELSE 'completed' END,max(m.createdAt),NULL,NULL,0,count(*),max(m.clientId),max(coalesce(m.evidence,'mcp_call'))
  FROM mcp_calls m WHERE m.sessionKey IS NOT NULL GROUP BY m.sessionKey
)`;
function evidence(source: string, scope: string): TrajectoryEvidence {
  return { certainty: source === "legacy_traffic" || source === "request_group" ? "derived" : "explicit", source, scope, confidence: source === "legacy_traffic" ? null : 1 };
}
function session(row: any): TrajectorySession { const { scope, evidence: source, ...rest } = row; return { ...rest, evidence: evidence(source, scope) }; }
export async function trajectorySessions(input: { kind?: string; query?: string; cursor?: string; limit?: number; minCalls?: number; maxCalls?: number; minEvents?: number; maxEvents?: number }): Promise<TrajectorySessionPage> {
  let before: { at: number; key: string } | null = null;
  if (input.cursor) {
    try { before = JSON.parse(Buffer.from(input.cursor, "base64url").toString()); } catch { throw new ApiError(400, "invalid_cursor"); }
    if (!before || !Number.isSafeInteger(before.at) || typeof before.key !== "string" || before.key.length > 400) throw new ApiError(400, "invalid_cursor");
  }
  const limit = input.limit || 40;
  const rows = sql().query(`${catalog} SELECT * FROM catalog WHERE (?='' OR kind=?) AND (?='' OR instr(lower(coalesce(title,'')||' '||coalesce(project,'')||' '||coalesce(agent,'')||' '||coalesce(nativeId,'')),lower(?))>0) AND calls>=? AND (? IS NULL OR calls<=?) AND events>=? AND (? IS NULL OR events<=?) AND (? IS NULL OR at<? OR (at=? AND key>?)) ORDER BY at DESC,key ASC LIMIT ?`).all(input.kind || "", input.kind || "", input.query || "", input.query || "", input.minCalls || 0, input.maxCalls ?? null, input.maxCalls ?? null, input.minEvents || 0, input.maxEvents ?? null, input.maxEvents ?? null, before?.at ?? null, before?.at ?? null, before?.at ?? null, before?.key ?? "", limit + 1) as any[];
  const more = rows.length > limit; if (more) rows.pop();
  const last = rows.at(-1);
  return { items: rows.map(session), next: more ? Buffer.from(JSON.stringify({ at: last.at, key: last.key })).toString("base64url") : null };
}
export function trajectorySession(key: string): TrajectorySession {
  const row = sql().query(`${catalog} SELECT * FROM catalog WHERE key=?`).get(key);
  if (!row) throw new ApiError(404, "session_not_found");
  return session(row);
}
function node(input: Pick<TrajectoryNode, "id" | "kind" | "title" | "status" | "source"> & Partial<TrajectoryNode>): TrajectoryNode {
  return { at: null, turn: null, turnEvidence: "unknown", step: null, parentId: null, role: null, durationMs: null, firstByteMs: null, firstTokenMs: null, decodingMs: null, inputTokens: null, outputTokens: null, requestId: null, relations: [], ...input };
}
function callNode(row: any): TrajectoryNode {
  return node({ id: `call:${row.id}`, kind: "model_call", title: `${row.model} · ${row.providerName}`, status: row.status, source: { kind: "traffic", id: row.id }, at: row.createdAt,
    turn: row.nativeTurnId || (row.turnNumber ? `turn:${row.turnNumber}` : null), turnEvidence: row.nativeTurnId || row.turnNumber ? "explicit" : "unknown", step: row.stepId || row.requestGroupId || row.id,
    relations: row.requestGroupId ? [{relation:"attempt_of",target:row.requestGroupId,callId:null,certainty:"explicit",source:"request_group",scope:row.ownerKey,confidence:1}] : [],
    requestId: row.id, durationMs: row.latencyMs, firstByteMs: row.firstByteMs, firstTokenMs: row.firstTokenMs, decodingMs: row.decodingMs, inputTokens: row.inputTokens, outputTokens: row.outputTokens });
}
function links(current: TrajectorySession): TrajectoryNodePage["links"] {
  if (!current.agent || !current.nativeId || !current.project) return [];
  const rows = sql().query(`${catalog} SELECT * FROM catalog WHERE agent=? AND nativeId=? AND project=? AND key<>? ORDER BY at DESC LIMIT 20`).all(current.agent, current.nativeId, current.project, current.key) as any[];
  return rows.map(row => ({ key: row.key, title: row.title, certainty: "candidate", source: "agent_native_id_project", scope: row.scope, confidence: null }));
}
export async function trajectoryNodes(input: { key: string; offset?: number; limit?: number; revision?: string }): Promise<TrajectoryNodePage> {
  const current = trajectorySession(input.key), offset = input.offset || 0, limit = input.limit || 40, database = sql();
  let revision = "", total = 0, items: TrajectoryNode[] = [];
  if (current.kind === "scanned") {
    const id = current.key.slice(8), state = database.query("SELECT generation,cursor,eventCount FROM sessions WHERE id=?").get(id) as { generation: number; cursor: number; eventCount: number };
    revision = `${state.generation}:${state.cursor}:${state.eventCount}`;
    if (input.revision && input.revision !== revision) throw new ApiError(409, "trajectory_changed");
    total = state.eventCount;
    const rows = database.query(`WITH events AS (SELECT id,kind,role,origin,metadata,nativeId,parentId,timestamp,offset,
      sum(CASE WHEN kind='message' AND role='user' AND origin='user' THEN 1 ELSE 0 END) OVER(ORDER BY offset) derivedTurn,
      max(CASE WHEN json_extract(metadata,'$.nativeType')='task_started' AND json_extract(metadata,'$.turnId') IS NOT NULL THEN offset END) OVER(ORDER BY offset) nativeTurnOffset
      FROM session_events WHERE sessionId=? AND generation=?) SELECT e.*,json_extract(t.metadata,'$.turnId') nativeTurn FROM events e LEFT JOIN session_events t ON t.sessionId=? AND t.offset=e.nativeTurnOffset ORDER BY e.offset LIMIT ? OFFSET ?`).all(id, state.generation, id, limit, offset) as any[];
    items = rows.map(row => {
      let metadata: any = {}; try { metadata = JSON.parse(row.metadata); } catch {}
      const nativeTurn = row.nativeTurn || metadata.turnId;
      const kind = ["message", "tool_call", "tool_result", "compaction", "branch"].includes(row.kind) ? row.kind : "metadata";
      const relations: TrajectoryNode["relations"] = [];
      if (kind === "tool_result") {
        const ids = Array.isArray(metadata.callIds) ? metadata.callIds : metadata.callId ? [metadata.callId] : [];
        for (const callId of ids.slice(0, 100)) {
          if (typeof callId !== "string") continue;
          const calls = database.query(`SELECT id FROM session_events WHERE sessionId=? AND generation=? AND kind='tool_call' AND offset<? AND (json_extract(metadata,'$.callId')=? OR EXISTS(SELECT 1 FROM json_each(json_extract(metadata,'$.tools')) tool WHERE json_extract(tool.value,'$.id')=?)) ORDER BY offset DESC LIMIT 2`).all(id, state.generation, row.offset, callId, callId) as {id:string}[];
          if (calls.length === 1) relations.push({relation:"tool_result_of",target:`event:${calls[0].id}`,callId,certainty:"explicit",source:"tool_call_id",scope:`session:${id}:${state.generation}`,confidence:1});
        }
      }
      return node({ id: `event:${row.id}`, kind, relations, title: metadata.name || metadata.toolName || metadata.tools?.map((tool: any) => tool.name).join(", ") || metadata.nativeType || row.role,
        status: row.kind === "parse_error" ? "partial" : "recorded", at: row.timestamp, turn: nativeTurn || (row.derivedTurn ? `derived:${row.derivedTurn}` : null), turnEvidence: nativeTurn ? "explicit" : row.derivedTurn ? "derived" : "unknown",
        step: row.nativeId || `offset:${row.offset}`, parentId: row.parentId, role: row.role, source: { kind: "session_event", id: row.id } });
    });
  } else if (current.kind === "managed") {
    const id = current.key.slice(8);
    const combined = `${catalog}, events AS (
      SELECT 'traffic' source,id,createdAt at FROM calls WHERE runId=?
      UNION ALL SELECT 'run_event',id,createdAt FROM run_events WHERE runId=?
      UNION ALL SELECT 'approval',id,createdAt FROM run_approvals WHERE runId=?
    )`;
    const meta = database.query(`${combined} SELECT count(*) n,max(at) last,max(id) marker FROM events`).get(id, id, id) as any;
    const mcpTotal=(database.query("SELECT count(*) n FROM mcp_calls WHERE sessionKey=?").get(current.key) as {n:number}).n;
    total = meta.n + mcpTotal; revision = `${total}:${meta.last}:${meta.marker}:${mcpTotal}`;
    if (input.revision && input.revision !== revision) throw new ApiError(409, "trajectory_changed");
    const rows = database.query(`${combined} SELECT * FROM events ORDER BY at,id LIMIT ? OFFSET ?`).all(id, id, id, limit, offset) as any[];
    items = rows.map(row => {
      if (row.source === "traffic") return callNode(database.query(`${catalog} SELECT * FROM calls WHERE id=?`).get(row.id));
      if (row.source === "approval") {
        const approval = database.query("SELECT id,kind,method,status,requestId FROM run_approvals WHERE id=?").get(row.id) as any;
        return node({ id: `approval:${row.id}`, kind: "approval", title: approval.method, status: approval.status, at: row.at, parentId: approval.requestId, source: { kind: "approval", id: row.id } });
      }
      const event = database.query("SELECT kind,turn,detail FROM run_events WHERE id=?").get(row.id) as any;
      return node({ id: `runtime:${row.id}`, kind: "runtime", title: event.kind, status: ["failed","cancelled","paused","completed"].includes(event.kind.split(".").at(-1)) ? event.kind.split(".").at(-1) : "recorded", at: row.at, turn: event.turn ? `turn:${event.turn}` : null, turnEvidence: event.turn ? "explicit" : "unknown", source: { kind: "run_event", id: row.id } });
    });
  } else {
    const meta = database.query(`${catalog} SELECT count(*) n,max(createdAt) last,max(id) marker FROM calls WHERE sessionKey=?`).get(current.key) as any;
    total = meta.n; revision = `${total}:${meta.last}:${meta.marker}`;
    if (input.revision && input.revision !== revision) throw new ApiError(409, "trajectory_changed");
    const rows = database.query(`${catalog} SELECT 'traffic' source,id,createdAt at,model title,status,requestGroupId,providerName,latencyMs,firstByteMs,firstTokenMs,decodingMs,inputTokens,outputTokens,nativeTurnId,turnNumber,stepId,NULL parentCallId,NULL sessionKey,NULL runId,NULL evidence FROM calls WHERE sessionKey=? UNION ALL SELECT 'mcp' source,id,createdAt at,name title,status,parentCallId,sessionKey,runId,evidence,NULL model,NULL providerName,NULL latencyMs,NULL firstByteMs,NULL firstTokenMs,NULL decodingMs,NULL inputTokens,NULL outputTokens,NULL nativeTurnId,NULL turnNumber,NULL stepId FROM mcp_calls WHERE sessionKey=? ORDER BY at,id LIMIT ? OFFSET ?`).all(current.key,current.key,limit,offset) as any[];
    total = (database.query(`${catalog} SELECT count(*) n FROM calls WHERE sessionKey=?`).get(current.key) as {n:number}).n + (database.query("SELECT count(*) n FROM mcp_calls WHERE sessionKey=?").get(current.key) as {n:number}).n;
    items = rows.map(row=>{
      if(row.source==='traffic')return callNode(row);
      const parentCallId=row.requestGroupId as string|null, sessionKey=row.providerName as string|null, evidence=row.firstByteMs as string|null;
      return node({id:`mcp:${row.id}`,kind:'tool_call',title:`MCP · ${row.title}`,status:row.status,at:row.at,turn:null,turnEvidence:'unknown',step:parentCallId||row.id,source:{kind:'mcp_call',id:row.id},relations:parentCallId?[{relation:'tool_result_of',target:`call:${parentCallId}`,callId:null,certainty:'explicit',source:evidence||'model_call_header',scope:sessionKey||current.key,confidence:1}]:[]});
    });
  }
  return { session: current, items, total, revision, next: offset + items.length < total ? offset + items.length : null, links: links(current) };
}
export async function loadTrajectoryNode(input: { key: string; kind: string; id: string; start?: number }) {
  const current = trajectorySession(input.key), database = sql();
  let value: any;
  if (input.kind === "run_event" && current.kind === "managed") value = database.query("SELECT * FROM run_events WHERE id=? AND runId=?").get(input.id, current.key.slice(8));
  else if (input.kind === "approval" && current.kind === "managed") value = database.query("SELECT id,kind,method,payload,status,response,requestId,createdAt,updatedAt FROM run_approvals WHERE id=? AND runId=?").get(input.id, current.key.slice(8));
  else if (input.kind === "mcp_call") value = database.query("SELECT id,createdAt,updatedAt,connectionName,name,kind,status,error,sessionKey,nativeSessionId,nativeTurnId,runId,parentCallId,evidence,project FROM mcp_calls WHERE id=? AND sessionKey=?").get(input.id, current.key);
  else if (input.kind === "traffic") value = database.query(`${catalog} SELECT * FROM calls WHERE id=? AND sessionKey=?`).get(input.id, current.key);
  else if (input.kind === "session_event" && current.kind === "scanned") {
    const { db, SessionSchema, SourceSchema, SessionEventSchema } = await import("./store");
    if (!db.isInitialized) await db.initialize();
    const session = await db.getRepository(SessionSchema).findOneBy({ id: current.key.slice(8) });
    const source = session?.sourceId ? await db.getRepository(SourceSchema).findOneBy({ id: session.sourceId }) : null;
    const event = session ? await db.getRepository(SessionEventSchema).findOneBy({ id: input.id, sessionId: session.id, generation: session.generation }) : null;
    if (!session || !source || !event) throw new ApiError(404, "session_not_found");
    const { readSessionRecord } = await import("./session-files");
    const text = await readSessionRecord(session, source, event);
    const authorized = await db.getRepository(SourceSchema).findOneBy({ id: source.id });
    if (!authorized?.enabled || !authorized.captureBodies || authorized.revision !== source.revision) throw new ApiError(403, "evidence_not_authorized");
    value = { source: { path: session.path, offset: event.offset, endOffset: event.endOffset, generation: event.generation, sourceId: source.id }, record: JSON.parse(text) };
  }
  if (!value) throw new ApiError(404, "trajectory_block_missing");
  for (const key of ["detail", "payload", "response", "decisions", "patchIds", "pricing"]) if (typeof value[key] === "string") try { value[key] = JSON.parse(value[key]); } catch {}
  return value;
}
export async function trajectoryNodeDetail(input: { key: string; kind: string; id: string; start?: number }) {
  const value = await loadTrajectoryNode(input);
  const text = JSON.stringify(value, null, 2), start = input.start || 0;
  let end = Math.min(start + 16384, text.length); if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return { text: text.slice(start, end), length: text.length, next: end < text.length ? end : null };
}
