import "reflect-metadata";
import { DataSource, EntitySchema, type EntitySchemaColumnOptions, type ObjectLiteral } from "typeorm";
import { join } from "node:path";
import { chmodSync } from "node:fs";
import { home } from "./config";
import { BunSqlite } from "./sqlite";
import type { Provider, ModelRoute, ClientKey, Traffic, Preference, Asset, Session, Audit, RecordBase, Run, McpConnection, RunEvent, RunApproval, CollectionSource, SessionEvent, PreferenceRevision, PreferenceEvidence, McpCall, McpCatalogRevision, BackgroundJob, AssetRoot, AssetSnapshot, AssetDeployment } from "../shared/types";

const text = (nullable = false): EntitySchemaColumnOptions => ({ type: "text", nullable });
const integer = (nullable = false): EntitySchemaColumnOptions => ({ type: "integer", nullable });
const json: EntitySchemaColumnOptions = { type: "simple-json" };
const boolean: EntitySchemaColumnOptions = { type: "boolean" };
const base = { id: { type: "text", primary: true }, createdAt: integer(), updatedAt: integer() } satisfies Record<string, EntitySchemaColumnOptions>;
/** 当前 schema 版本。**新增迁移时必须同步改这里** —— 下面的守卫与迁移块若与它脱钩，
 *  库升到新版本后的下一次启动会被守卫误判为"过新的库"而拒绝启动。 */
export const SCHEMA_VERSION = 26;
function schema<T extends ObjectLiteral>(name: string, columns: Record<string, EntitySchemaColumnOptions>) {
  return new EntitySchema<T>({ name, tableName: name, columns: { ...base, ...columns } as never });
}
export const ProviderSchema = schema<Provider>("providers", {
  name: text(), protocol: text(), baseUrl: text(), secretCipher: text(true), enabled: boolean,
  health: text(), latencyMs: integer(true), lastChecked: integer(true), lastError: text(true),
});
export const RouteSchema = schema<ModelRoute>("routes", {
  alias: { ...text(), unique: true }, protocol: text(), targets: json, enabled: boolean, strategy: { ...text(), default: "priority" },
  inputPrice: { type: "real", nullable: true }, outputPrice: { type: "real", nullable: true },
  contextLimit: integer(), outputLimit: integer(), cacheReadPrice: { type: "real", nullable: true }, cacheWritePrice: { type: "real", nullable: true }, cacheWriteLongPrice: { type: "real", nullable: true },
});
export const ClientSchema = schema<ClientKey>("clients", {
  name: text(), kind: { ...text(), default: "long_term" }, keyHash: { ...text(), unique: true }, keyPreview: text(), enabled: boolean,
  project: text(true), personalize: boolean, routeIds: json, lastUsedAt: integer(true),
  budgetMicros: integer(true), tokenLimit: integer(true), maxConcurrent: { ...integer(), default: 4 }, runId: text(true), expiresAt: integer(true), mcpGrants: { ...json, default: '[]' }, memoryAccess: { ...boolean, default: false }, modelAliases: { ...json, default: '[]' },
});
export const TrafficSchema = schema<Traffic>("traffic", {
  clientId: text(), clientName: text(), routeId: text(), model: text(), providerId: text(), providerName: text(),
  protocol: text(), status: text(), upstreamStatus: integer(true), latencyMs: integer(true), firstByteMs: integer(true), firstTokenMs: integer(true), decodingMs: integer(true),
  inputTokens: integer(true), outputTokens: integer(true), costMicros: integer(true), error: text(true), requestHeaders: { ...json, default: "{}" },
  stream: boolean, project: text(true), patchIds: json, requestGroupId: text(true), affinityId: text(true), responseId: text(true), cacheReadTokens: { ...integer(), default: 0 }, cacheWriteTokens: { ...integer(), default: 0 }, cacheWriteLongTokens: { ...integer(), default: 0 }, reasoningTokens: { ...integer(), default: 0 }, decisions: { ...json, default: '[]' }, bytesTotal: { ...integer(), default: 0 }, progressAt: integer(true), runId: text(true), accounting: { ...text(), default: "unknown" }, pricing: { ...json, default: '{"input":null,"output":null}' },
});
export const PreferenceSchema = schema<Preference>("preferences", {
  title: text(), content: text(), scope: text(), project: text(true), status: text(), source: text(),
  evidence: text(true), revision: integer(),
});
export const AssetSchema = schema<Asset>("assets", {
  kind: text(), name: text(), source: text(), path: { ...text(), unique: true }, version: text(true),
  hash: text(true), description: text(true), status: text(), metadata: json,
});
export const SessionSchema = schema<Session>("sessions", {
  agent: text(), nativeId: text(), title: text(), project: text(true), path: { ...text(), unique: true },
  model: text(true), messageCount: integer(), lastActiveAt: integer(), size: integer(), cursor: integer(), status: text(), sourceId: text(true), generation: { ...integer(), default: 0 }, fileIdentity: text(true), prefixHash: text(true), fileMtime: { ...integer(), default: 0 }, parserVersion: { ...integer(), default: 0 }, eventCount: { ...integer(), default: 0 }, parseErrors: { ...integer(), default: 0 }, parentSessionId: text(true), lastError: text(true), captured: { ...boolean, default: false }, archived: { ...boolean, default: false }, starred: { ...boolean, default: false }, tags: { ...json, default: '[]' },
});
export const AuditSchema = schema<Audit>("audit", { action: text(), subject: text(), detail: json });
const SettingSchema = schema<{ id: string; createdAt: number; updatedAt: number; value: unknown }>("settings", { value: json });
export const RunSchema = schema<Run>("runs", { agent: text(), goal: text(), workspace: text(), routeId: text(), status: text(), output: text(), exitCode: integer(true), timeoutSeconds: integer(), endedAt: integer(true), controls: { ...json, default: '{"mode":"turn","maxTurns":1,"maxNoProgress":3,"budgetMicros":null,"tokenLimit":null,"permission":"read-only","completionFiles":[]}' }, turnCount: { ...integer(), default: 0 }, nativeSessionId: text(true), nativeTurnId: text(true), clientId: text(true), elapsedMs: { ...integer(), default: 0 }, stopReason: text(true), progressHash: text(true), noProgressCount: { ...integer(), default: 0 }, leaseOwner: text(true), leaseExpiresAt: integer(true) });
export const McpSchema = schema<McpConnection>("mcp_connections", { name: text(), transport: text(), url: text(true), command: text(true), args: json, envCipher: text(true), headersCipher: text(true), enabled: boolean, status: text(), version: text(true), tools: json, resources: { ...json, default: '[]' }, prompts: { ...json, default: '[]' }, capabilities: json, schemaHash: text(true), previousSchemaHash: text(true), lastChecked: integer(true), lastError: text(true) });
export const RunEventSchema = schema<RunEvent>("run_events", { runId: text(), kind: text(), turn: integer(), detail: json });
export const ApprovalSchema = schema<RunApproval>("run_approvals", { runId: text(), requestId: text(), kind: text(), method: text(), payload: json, status: text(), response: { ...json, nullable: true } });
export const SourceSchema = schema<CollectionSource>("collection_sources", { name: text(), agent: text(), path: { ...text(), unique: true }, enabled: boolean, captureBodies: boolean, learn: boolean, revision: integer(), lastScanAt: integer(true), lastError: text(true), fileCount: integer(), state: text() });
export const SessionEventSchema = schema<SessionEvent>("session_events", { sessionId: text(), generation: integer(), sourceKey: text(), nativeId: text(true), parentId: text(true), kind: text(), role: text(), origin: text(), text: text(true), metadata: json, offset: integer(), endOffset: integer(), timestamp: integer(true) });
export const PreferenceRevisionSchema = schema<PreferenceRevision>("preference_revisions", { preferenceId: text(), revision: integer(), title: text(), content: text(), scope: text(), project: text(true), status: text(), reason: text() });
export const EvidenceSchema = schema<PreferenceEvidence>("preference_evidence", { preferenceId: text(), eventId: text(true), sourceId: text(true), sessionId: text(true), excerpt: text(), kind: text(), confidence: { type: "real" } });
export const McpCallSchema = schema<McpCall>("mcp_calls", { connectionId: text(), connectionName: text(), clientId: text(true), clientName: text(), project: text(true), kind: text(), name: text(), schemaHash: text(), requestCipher: text(), sessionKey: text(true), nativeSessionId: text(true), nativeTurnId: text(true), runId: text(true), parentCallId: text(true), evidence: text(true), status: text(), resultCipher: text(true), error: text(true), expiresAt: integer(), startedAt: integer(true), endedAt: integer(true) });
export const McpRevisionSchema = schema<McpCatalogRevision>("mcp_revisions", { connectionId: text(), hash: text(), version: text(true), catalog: json });
export const JobSchema = schema<BackgroundJob>("background_jobs", { kind:text(),label:text(),status:text(),payloadCipher:text(),resultCipher:text(true),dedupKey:text(true),phase:text(),processed:integer(),total:integer(true),currentItem:text(true),attempts:integer(),nextRunAt:integer(),startedAt:integer(true),endedAt:integer(true),heartbeatAt:integer(true),cancelRequested:boolean,error:text(true) });
export const AssetRootSchema=schema<AssetRoot>("asset_roots",{name:text(),path:{...text(),unique:true},agent:text(),project:text(true),enabled:boolean,followSymlinks:boolean,capture:boolean,revision:integer(),lastScanAt:integer(true),lastError:text(true),count:integer()});
export const SnapshotSchema=schema<AssetSnapshot>("asset_snapshots",{assetId:text(),hash:text(),bytes:integer(),files:json,contentCipher:text(),version:text(true)});
export const DeploymentSchema=schema<AssetDeployment>("asset_deployments",{assetId:text(),snapshotId:text(),target:text(),targetRoot:text(),agent:text(),status:text(),beforeHash:text(true),afterHash:text(),beforeCipher:text(true),afterCipher:text(),stagePath:text(true),error:text(true),diff:json});
const entities = [AssetRootSchema,SnapshotSchema,DeploymentSchema, JobSchema, McpCallSchema, McpRevisionSchema, SourceSchema, SessionEventSchema, PreferenceRevisionSchema, EvidenceSchema, RunEventSchema, ApprovalSchema, McpSchema, RunSchema, ProviderSchema, RouteSchema, ClientSchema, TrafficSchema, PreferenceSchema, AssetSchema, SessionSchema, AuditSchema, SettingSchema];
const filename = join(home, "gateway.sqlite");
export const db = new DataSource({
  type: "better-sqlite3", driver: BunSqlite, database: filename, entities, synchronize: false,
  prepareDatabase(database: any) {
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
  },
});
export async function initializeStore() {
  await db.initialize();
  await db.query('CREATE TABLE IF NOT EXISTS schema_versions (version INTEGER PRIMARY KEY, appliedAt INTEGER NOT NULL)');
  const versions = await db.query('SELECT version FROM schema_versions ORDER BY version DESC LIMIT 1');
  if (!versions.length) {
    await db.synchronize();
    await db.query('CREATE INDEX IF NOT EXISTS traffic_created ON traffic(createdAt)');
    await db.query('CREATE INDEX IF NOT EXISTS sessions_active ON sessions(lastActiveAt)');
    await db.query('INSERT INTO schema_versions(version, appliedAt) VALUES (2, ?)', [Date.now()]);
  } else if (versions[0].version === 1) {
    await db.transaction(async manager => {
      await manager.query('CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, agent TEXT NOT NULL, goal TEXT NOT NULL, workspace TEXT NOT NULL, routeId TEXT NOT NULL, status TEXT NOT NULL, output TEXT NOT NULL, exitCode INTEGER, timeoutSeconds INTEGER NOT NULL, endedAt INTEGER)');
      await manager.query('CREATE TABLE IF NOT EXISTS mcp_connections (id TEXT PRIMARY KEY, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, name TEXT NOT NULL, transport TEXT NOT NULL, url TEXT, command TEXT, args TEXT NOT NULL, envCipher TEXT, headersCipher TEXT, enabled BOOLEAN NOT NULL, status TEXT NOT NULL, version TEXT, tools TEXT NOT NULL, capabilities TEXT NOT NULL, schemaHash TEXT, previousSchemaHash TEXT, lastChecked INTEGER, lastError TEXT)');
      await manager.query('INSERT INTO schema_versions(version, appliedAt) VALUES (2, ?)', [Date.now()]);
    });
  } else if (versions[0].version > SCHEMA_VERSION) throw new Error("Unsupported database schema");
  chmodSync(filename, 0o600);
  const [current] = await db.query('SELECT MAX(version) as version FROM schema_versions');
  if (current.version < 3) {
    await db.transaction(async manager => {
      const changes: Record<string, Record<string, string>> = {
        clients: { budgetMicros: 'INTEGER', tokenLimit: 'INTEGER', maxConcurrent: 'INTEGER NOT NULL DEFAULT 4', runId: 'TEXT', expiresAt: 'INTEGER' },
        traffic: { runId: 'TEXT', accounting: "TEXT NOT NULL DEFAULT 'unknown'", pricing: `TEXT NOT NULL DEFAULT '{"input":null,"output":null}'` },
        runs: { controls: `TEXT NOT NULL DEFAULT '{"mode":"turn","maxTurns":1,"maxNoProgress":3,"budgetMicros":null,"tokenLimit":null,"permission":"read-only","completionFiles":[]}'`, turnCount: 'INTEGER NOT NULL DEFAULT 0', nativeSessionId: 'TEXT', nativeTurnId: 'TEXT', clientId: 'TEXT', elapsedMs: 'INTEGER NOT NULL DEFAULT 0', stopReason: 'TEXT', progressHash: 'TEXT', noProgressCount: 'INTEGER NOT NULL DEFAULT 0', leaseOwner: 'TEXT', leaseExpiresAt: 'INTEGER' },
      };
      for (const [table, columns] of Object.entries(changes)) {
        const existing = await manager.query(`PRAGMA table_info(${table})`) as { name: string }[];
        for (const [name, definition] of Object.entries(columns)) if (!existing.some(c => c.name === name)) await manager.query(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
      await manager.query('CREATE TABLE IF NOT EXISTS run_events (id TEXT PRIMARY KEY, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, runId TEXT NOT NULL, kind TEXT NOT NULL, turn INTEGER NOT NULL, detail TEXT NOT NULL)');
      await manager.query('CREATE TABLE IF NOT EXISTS run_approvals (id TEXT PRIMARY KEY, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, runId TEXT NOT NULL, requestId TEXT NOT NULL, kind TEXT NOT NULL, method TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, response TEXT)');
      await manager.query('CREATE INDEX IF NOT EXISTS run_events_run ON run_events(runId, createdAt)');
      await manager.query("CREATE TABLE IF NOT EXISTS budget_reservations (id TEXT PRIMARY KEY, clientId TEXT NOT NULL, runId TEXT, project TEXT, createdAt INTEGER NOT NULL, reservedMicros INTEGER NOT NULL, reservedTokens INTEGER NOT NULL, costMicros INTEGER, tokens INTEGER, status TEXT NOT NULL, inputPrice TEXT, outputPrice TEXT)");
      await manager.query('CREATE INDEX IF NOT EXISTS budget_client ON budget_reservations(clientId, status)');
      await manager.query('CREATE INDEX IF NOT EXISTS budget_run ON budget_reservations(runId, status)');
      await manager.query('CREATE INDEX IF NOT EXISTS traffic_run ON traffic(runId, createdAt)');
      await manager.query('INSERT INTO schema_versions(version, appliedAt) VALUES (3, ?)', [Date.now()]);
    });
  }
  const [latest] = await db.query('SELECT MAX(version) as version FROM schema_versions');
  if (latest.version < 4) {
    await db.transaction(async manager => {
      const columns = { sourceId: 'TEXT', generation: 'INTEGER NOT NULL DEFAULT 0', fileIdentity: 'TEXT', prefixHash: 'TEXT', fileMtime: 'INTEGER NOT NULL DEFAULT 0', parserVersion: 'INTEGER NOT NULL DEFAULT 0', eventCount: 'INTEGER NOT NULL DEFAULT 0', parseErrors: 'INTEGER NOT NULL DEFAULT 0', parentSessionId: 'TEXT', lastError: 'TEXT', captured: 'BOOLEAN NOT NULL DEFAULT 0', archived: 'BOOLEAN NOT NULL DEFAULT 0', starred: 'BOOLEAN NOT NULL DEFAULT 0', tags: "TEXT NOT NULL DEFAULT '[]'" };
      const existing = await manager.query('PRAGMA table_info(sessions)') as { name: string }[];
      for (const [name, definition] of Object.entries(columns)) if (!existing.some(c => c.name === name)) await manager.query(`ALTER TABLE sessions ADD COLUMN ${name} ${definition}`);
      await manager.query('CREATE TABLE IF NOT EXISTS collection_sources (id TEXT PRIMARY KEY,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,name TEXT NOT NULL,agent TEXT NOT NULL,path TEXT NOT NULL UNIQUE,enabled BOOLEAN NOT NULL,captureBodies BOOLEAN NOT NULL,learn BOOLEAN NOT NULL,revision INTEGER NOT NULL,lastScanAt INTEGER,lastError TEXT,fileCount INTEGER NOT NULL,state TEXT NOT NULL)');
      await manager.query('CREATE TABLE IF NOT EXISTS session_events (id TEXT PRIMARY KEY,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,sessionId TEXT NOT NULL,generation INTEGER NOT NULL,sourceKey TEXT NOT NULL,nativeId TEXT,parentId TEXT,kind TEXT NOT NULL,role TEXT NOT NULL,origin TEXT NOT NULL,text TEXT,metadata TEXT NOT NULL,offset INTEGER NOT NULL,endOffset INTEGER NOT NULL,timestamp INTEGER)');
      await manager.query('CREATE UNIQUE INDEX IF NOT EXISTS session_event_identity ON session_events(sessionId,generation,sourceKey)');
      await manager.query('CREATE INDEX IF NOT EXISTS session_event_position ON session_events(sessionId,offset)');
      await manager.query('CREATE INDEX IF NOT EXISTS sessions_source ON sessions(sourceId,fileIdentity)');
      await manager.query('CREATE TABLE IF NOT EXISTS preference_revisions (id TEXT PRIMARY KEY,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,preferenceId TEXT NOT NULL,revision INTEGER NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,scope TEXT NOT NULL,project TEXT,status TEXT NOT NULL,reason TEXT NOT NULL)');
      await manager.query('CREATE UNIQUE INDEX IF NOT EXISTS preference_revision_identity ON preference_revisions(preferenceId,revision)');
      await manager.query('CREATE TABLE IF NOT EXISTS preference_evidence (id TEXT PRIMARY KEY,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,preferenceId TEXT NOT NULL,eventId TEXT,sourceId TEXT,sessionId TEXT,excerpt TEXT NOT NULL,kind TEXT NOT NULL,confidence REAL NOT NULL)');
      await manager.query('CREATE INDEX IF NOT EXISTS evidence_event ON preference_evidence(eventId)');
      await manager.query('CREATE INDEX IF NOT EXISTS evidence_preference ON preference_evidence(preferenceId)');
      await manager.query('CREATE TABLE IF NOT EXISTS session_tombstones (sourceId TEXT NOT NULL,path TEXT NOT NULL,deletedAt INTEGER NOT NULL,PRIMARY KEY(sourceId,path))');
      await manager.query(`CREATE VIRTUAL TABLE IF NOT EXISTS session_search USING fts5(eventId UNINDEXED,sessionId UNINDEXED,text, tokenize='trigram')`);
      await manager.query(`CREATE TRIGGER IF NOT EXISTS session_search_insert AFTER INSERT ON session_events WHEN new.text IS NOT NULL BEGIN INSERT INTO session_search(eventId,sessionId,text) VALUES(new.id,new.sessionId,new.text); END`);
      await manager.query(`CREATE TRIGGER IF NOT EXISTS session_search_delete AFTER DELETE ON session_events BEGIN DELETE FROM session_search WHERE eventId=old.id; END`);
      await manager.query(`CREATE TRIGGER IF NOT EXISTS session_search_update AFTER UPDATE OF text ON session_events BEGIN DELETE FROM session_search WHERE eventId=old.id; INSERT INTO session_search(eventId,sessionId,text) SELECT new.id,new.sessionId,new.text WHERE new.text IS NOT NULL; END`);
      const prefs = await manager.getRepository(PreferenceSchema).find();
      for (const preference of prefs) {
        await manager.getRepository(PreferenceRevisionSchema).save({ ...record(), preferenceId: preference.id, revision: preference.revision, title: preference.title, content: preference.content, scope: preference.scope, project: preference.project, status: preference.status, reason: 'migration_baseline' });
      }
      await manager.query('INSERT INTO schema_versions(version,appliedAt) VALUES (4,?)', [Date.now()]);
    });
  }
  const [memoryVersion] = await db.query('SELECT MAX(version) as version FROM schema_versions');
  if (memoryVersion.version < 5) {
    await db.transaction(async manager => {
      await manager.query('CREATE TABLE IF NOT EXISTS preference_tombstones (id TEXT PRIMARY KEY,deletedAt INTEGER NOT NULL)');
      await manager.query('INSERT INTO schema_versions(version,appliedAt) VALUES(5,?)', [Date.now()]);
    });
  }
  const [mcpVersion] = await db.query('SELECT MAX(version) as version FROM schema_versions');
  if (mcpVersion.version < 6) {
    await db.transaction(async manager => {
      const changes = { clients: { mcpGrants: "TEXT NOT NULL DEFAULT '[]'", memoryAccess: 'BOOLEAN NOT NULL DEFAULT 0' }, mcp_connections: { resources: "TEXT NOT NULL DEFAULT '[]'", prompts: "TEXT NOT NULL DEFAULT '[]'" } };
      for (const [table, columns] of Object.entries(changes)) {
        const existing = await manager.query(`PRAGMA table_info(${table})`) as { name: string }[];
        for (const [name, type] of Object.entries(columns)) if (!existing.some(c => c.name === name)) await manager.query(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
      await manager.query('CREATE TABLE IF NOT EXISTS mcp_calls(id TEXT PRIMARY KEY,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,connectionId TEXT NOT NULL,connectionName TEXT NOT NULL,clientId TEXT,clientName TEXT NOT NULL,project TEXT,kind TEXT NOT NULL,name TEXT NOT NULL,schemaHash TEXT NOT NULL,requestCipher TEXT NOT NULL,status TEXT NOT NULL,resultCipher TEXT,error TEXT,expiresAt INTEGER NOT NULL,startedAt INTEGER,endedAt INTEGER)');
      await manager.query('CREATE INDEX IF NOT EXISTS mcp_calls_status ON mcp_calls(status,createdAt)');
      await manager.query('CREATE INDEX IF NOT EXISTS mcp_calls_client ON mcp_calls(clientId,status)');
      await manager.query('CREATE TABLE IF NOT EXISTS mcp_revisions(id TEXT PRIMARY KEY,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,connectionId TEXT NOT NULL,hash TEXT NOT NULL,version TEXT,catalog TEXT NOT NULL)');
      await manager.query('CREATE INDEX IF NOT EXISTS mcp_revisions_connection ON mcp_revisions(connectionId,createdAt)');
      await manager.query('INSERT INTO schema_versions(version,appliedAt) VALUES(6,?)', [Date.now()]);
    });
  }
  const [routingVersion] = await db.query('SELECT MAX(version) as version FROM schema_versions');
  if (routingVersion.version < 7) {
    await db.transaction(async manager => {
      const changes = { routes: { cacheReadPrice: 'REAL', cacheWritePrice: 'REAL', cacheWriteLongPrice: 'REAL' }, traffic: { requestGroupId: 'TEXT', affinityId: 'TEXT', responseId: 'TEXT', cacheReadTokens: 'INTEGER NOT NULL DEFAULT 0', cacheWriteTokens: 'INTEGER NOT NULL DEFAULT 0', cacheWriteLongTokens: 'INTEGER NOT NULL DEFAULT 0', reasoningTokens: 'INTEGER NOT NULL DEFAULT 0', decisions: "TEXT NOT NULL DEFAULT '[]'" } };
      for (const [table, columns] of Object.entries(changes)) {
        const existing = await manager.query(`PRAGMA table_info(${table})`) as { name: string }[];
        for (const [name, type] of Object.entries(columns)) if (!existing.some(c => c.name === name)) await manager.query(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
      await manager.query('CREATE TABLE IF NOT EXISTS route_sessions(id TEXT PRIMARY KEY,ownerKey TEXT NOT NULL,routeId TEXT NOT NULL,sessionKey TEXT NOT NULL,providerId TEXT,providerFingerprint TEXT,model TEXT,preferencesCipher TEXT,patchIds TEXT NOT NULL,leaseId TEXT,leaseExpiresAt INTEGER,uncertain BOOLEAN NOT NULL DEFAULT 0,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,UNIQUE(ownerKey,routeId,sessionKey))');
      await manager.query('CREATE TABLE IF NOT EXISTS response_bindings(ownerKey TEXT NOT NULL,responseId TEXT NOT NULL,routeId TEXT NOT NULL,affinityId TEXT NOT NULL,providerId TEXT NOT NULL,providerFingerprint TEXT NOT NULL,model TEXT NOT NULL,status TEXT NOT NULL,createdAt INTEGER NOT NULL,PRIMARY KEY(ownerKey,responseId))');
      await manager.query('CREATE INDEX IF NOT EXISTS response_affinity ON response_bindings(affinityId)');
      await manager.query('CREATE TABLE IF NOT EXISTS provider_circuits(id TEXT PRIMARY KEY,providerId TEXT NOT NULL,model TEXT NOT NULL,fingerprint TEXT NOT NULL,failures INTEGER NOT NULL,openUntil INTEGER NOT NULL,probeUntil INTEGER NOT NULL,lastError TEXT,updatedAt INTEGER NOT NULL)');
      await manager.query('CREATE INDEX IF NOT EXISTS traffic_group ON traffic(requestGroupId)');
      await manager.query('INSERT INTO schema_versions(version,appliedAt) VALUES(7,?)', [Date.now()]);
    });
  }
  const [jobVersion] = await db.query('SELECT MAX(version) as version FROM schema_versions');
  if (jobVersion.version < 8) {
    await db.transaction(async manager => {
      await manager.query('CREATE TABLE IF NOT EXISTS background_jobs(id TEXT PRIMARY KEY,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,kind TEXT NOT NULL,label TEXT NOT NULL,status TEXT NOT NULL,payloadCipher TEXT NOT NULL,resultCipher TEXT,dedupKey TEXT,phase TEXT NOT NULL,processed INTEGER NOT NULL,total INTEGER,currentItem TEXT,attempts INTEGER NOT NULL,nextRunAt INTEGER NOT NULL,startedAt INTEGER,endedAt INTEGER,heartbeatAt INTEGER,cancelRequested BOOLEAN NOT NULL,error TEXT)');
      await manager.query('CREATE INDEX IF NOT EXISTS jobs_queue ON background_jobs(status,nextRunAt,createdAt)');
      await manager.query('CREATE INDEX IF NOT EXISTS jobs_dedup ON background_jobs(dedupKey,status)');
      await manager.query('INSERT INTO schema_versions(version,appliedAt) VALUES(8,?)',[Date.now()]);
    });
  }
  const [balanceVersion]=await db.query('SELECT MAX(version) version FROM schema_versions');
  if(balanceVersion.version<9){await db.transaction(async manager=>{
    const columns=await manager.query('PRAGMA table_info(routes)') as {name:string}[];
    if(!columns.some(c=>c.name==='strategy'))await manager.query("ALTER TABLE routes ADD COLUMN strategy TEXT NOT NULL DEFAULT 'priority'");
    const reservationColumns=await manager.query('PRAGMA table_info(budget_reservations)') as {name:string}[];
    if(!reservationColumns.some(c=>c.name==='targetKey'))await manager.query('ALTER TABLE budget_reservations ADD COLUMN targetKey TEXT');
    await manager.query('CREATE TABLE IF NOT EXISTS route_counters(routeId TEXT PRIMARY KEY,value INTEGER NOT NULL)');
    await manager.query('CREATE INDEX IF NOT EXISTS reservations_target ON budget_reservations(targetKey,status)');
    await manager.query('INSERT INTO schema_versions(version,appliedAt) VALUES(9,?)',[Date.now()]);
  });}
  const [debugVersion]=await db.query('SELECT MAX(version) version FROM schema_versions');
  if(debugVersion.version<10){await db.transaction(async manager=>{
    await manager.query('CREATE TABLE IF NOT EXISTS debug_attempts(id TEXT PRIMARY KEY,jobId TEXT NOT NULL,number INTEGER NOT NULL,status TEXT NOT NULL,httpStatus INTEGER,requestId TEXT,bodyCipher TEXT,error TEXT,bytes INTEGER NOT NULL,startedAt INTEGER NOT NULL,endedAt INTEGER,UNIQUE(jobId,number))');
    await manager.query('CREATE INDEX IF NOT EXISTS debug_attempts_job ON debug_attempts(jobId,number)');
    await manager.query('INSERT INTO schema_versions(version,appliedAt) VALUES(10,?)',[Date.now()]);
  });}
  const [assetVersion]=await db.query('SELECT MAX(version) version FROM schema_versions');
  if(assetVersion.version<11){await db.transaction(async manager=>{
    await manager.query('CREATE TABLE IF NOT EXISTS asset_roots(id TEXT PRIMARY KEY,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,name TEXT NOT NULL,path TEXT NOT NULL UNIQUE,agent TEXT NOT NULL,project TEXT,enabled BOOLEAN NOT NULL,followSymlinks BOOLEAN NOT NULL,capture BOOLEAN NOT NULL,revision INTEGER NOT NULL,lastScanAt INTEGER,lastError TEXT,count INTEGER NOT NULL)');
    await manager.query('CREATE TABLE IF NOT EXISTS asset_snapshots(id TEXT PRIMARY KEY,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,assetId TEXT NOT NULL,hash TEXT NOT NULL,bytes INTEGER NOT NULL,files TEXT NOT NULL,contentCipher TEXT NOT NULL,version TEXT)');
    await manager.query('CREATE UNIQUE INDEX IF NOT EXISTS asset_snapshot_content ON asset_snapshots(assetId,hash)');
    await manager.query('CREATE TABLE IF NOT EXISTS asset_deployments(id TEXT PRIMARY KEY,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,assetId TEXT NOT NULL,snapshotId TEXT NOT NULL,target TEXT NOT NULL,targetRoot TEXT NOT NULL,agent TEXT NOT NULL,status TEXT NOT NULL,beforeHash TEXT,afterHash TEXT NOT NULL,beforeCipher TEXT,afterCipher TEXT NOT NULL,stagePath TEXT,error TEXT,diff TEXT NOT NULL)');
    await manager.query('CREATE INDEX IF NOT EXISTS deployments_target ON asset_deployments(target,status)');
    await manager.query('INSERT INTO schema_versions(version,appliedAt) VALUES(11,?)',[Date.now()]);
  });}
  const [captureVersion]=await db.query('SELECT MAX(version) version FROM schema_versions');
  if(captureVersion.version<12){await db.transaction(async manager=>{
    await manager.query('CREATE TABLE IF NOT EXISTS request_captures(requestId TEXT PRIMARY KEY,requestGroupId TEXT NOT NULL,policyRevision INTEGER NOT NULL,state TEXT NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,expiresAt INTEGER NOT NULL,bytes INTEGER NOT NULL DEFAULT 0,reason TEXT,metadataCipher TEXT NOT NULL)');
    await manager.query('CREATE TABLE IF NOT EXISTS request_capture_parts(requestId TEXT NOT NULL,stage TEXT NOT NULL,sequence INTEGER NOT NULL,bytes INTEGER NOT NULL,bodyCipher TEXT NOT NULL,PRIMARY KEY(requestId,stage,sequence))');
    await manager.query('CREATE INDEX IF NOT EXISTS captures_expiry ON request_captures(expiresAt)');
    await manager.query('CREATE INDEX IF NOT EXISTS captures_group ON request_captures(requestGroupId)');
    await manager.query('INSERT INTO schema_versions(version,appliedAt) VALUES(12,?)',[Date.now()]);
  });}
  const [fileIndexVersion]=await db.query('SELECT MAX(version) version FROM schema_versions');
  if(fileIndexVersion.version<13){await db.transaction(async manager=>{
    for(const trigger of ["session_search_insert","session_search_delete","session_search_update"]) await manager.query(`DROP TRIGGER IF EXISTS ${trigger}`);
    await manager.query('INSERT INTO schema_versions(version,appliedAt) VALUES(13,?)',[Date.now()]);
  });}
  const [keyKindVersion]=await db.query('SELECT MAX(version) version FROM schema_versions');
  if(keyKindVersion.version<14){await db.transaction(async manager=>{
    const existing=await manager.query('PRAGMA table_info(clients)') as {name:string}[];
    if(!existing.some(c=>c.name==='kind'))await manager.query("ALTER TABLE clients ADD COLUMN kind TEXT NOT NULL DEFAULT 'long_term'");
    await manager.query('INSERT INTO schema_versions(version,appliedAt) VALUES(14,?)',[Date.now()]);
  });}
  const [observabilityVersion]=await db.query('SELECT MAX(version) version FROM schema_versions');
  if(observabilityVersion.version<15){await db.transaction(async manager=>{
    await manager.query('CREATE TABLE IF NOT EXISTS observability_snapshots(id TEXT PRIMARY KEY,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,label TEXT NOT NULL,hash TEXT NOT NULL,summary TEXT NOT NULL,contentCipher TEXT NOT NULL)');
    await manager.query('CREATE INDEX IF NOT EXISTS observability_snapshots_created ON observability_snapshots(createdAt DESC)');
    await manager.query('INSERT INTO schema_versions(version,appliedAt) VALUES(15,?)',[Date.now()]);
  });}
  const [trajectoryVersion]=await db.query('SELECT MAX(version) version FROM schema_versions');
  if(trajectoryVersion.version<16){await db.transaction(async manager=>{
    await manager.query('CREATE TABLE IF NOT EXISTS trajectory_call_context(requestId TEXT PRIMARY KEY REFERENCES traffic(id) ON DELETE CASCADE,sessionKey TEXT NOT NULL,ownerKey TEXT NOT NULL,agent TEXT,nativeSessionId TEXT,nativeTurnId TEXT,stepId TEXT,runId TEXT,turnNumber INTEGER,evidence TEXT NOT NULL,project TEXT,createdAt INTEGER NOT NULL)');
    await manager.query('CREATE INDEX IF NOT EXISTS trajectory_context_session ON trajectory_call_context(sessionKey,createdAt,requestId)');
    await manager.query('CREATE INDEX IF NOT EXISTS trajectory_context_native ON trajectory_call_context(agent,nativeSessionId,project)');
    await manager.query('CREATE INDEX IF NOT EXISTS trajectory_traffic_run ON traffic(runId,createdAt,id)');
    await manager.query('CREATE INDEX IF NOT EXISTS trajectory_traffic_affinity ON traffic(affinityId,createdAt,id)');
    await manager.query('CREATE INDEX IF NOT EXISTS trajectory_sessions_native ON sessions(agent,nativeId,project)');
    await manager.query('CREATE INDEX IF NOT EXISTS trajectory_run_events ON run_events(runId,createdAt,id)');
    await manager.query('INSERT INTO schema_versions(version,appliedAt) VALUES(16,?)',[Date.now()]);
  });}
  const [snapshotVersion]=await db.query('SELECT MAX(version) version FROM schema_versions');
  if(snapshotVersion.version<17){await db.transaction(async manager=>{
    await manager.query('CREATE TABLE IF NOT EXISTS trajectory_snapshots(id TEXT PRIMARY KEY,createdAt INTEGER NOT NULL,expiresAt INTEGER NOT NULL,label TEXT NOT NULL,sessionKey TEXT NOT NULL,nodeKind TEXT NOT NULL,nodeId TEXT NOT NULL,hash TEXT NOT NULL,bytes INTEGER NOT NULL,coverage TEXT NOT NULL,state TEXT NOT NULL,stages TEXT NOT NULL)');
    await manager.query('CREATE INDEX IF NOT EXISTS trajectory_snapshots_session ON trajectory_snapshots(sessionKey,createdAt,id)');
    await manager.query('CREATE INDEX IF NOT EXISTS trajectory_snapshots_expiry ON trajectory_snapshots(state,expiresAt)');
    await manager.query('INSERT INTO schema_versions(version,appliedAt) VALUES(17,?)',[Date.now()]);
  });}
  const [timingVersion]=await db.query('SELECT MAX(version) version FROM schema_versions');
  if(timingVersion.version<19){await db.transaction(async manager=>{
    const existing=await manager.query('PRAGMA table_info(traffic)') as {name:string}[];
    for(const [name,type] of [['firstTokenMs','INTEGER'],['decodingMs','INTEGER']] as const)if(!existing.some(c=>c.name===name))await manager.query(`ALTER TABLE traffic ADD COLUMN ${name} ${type}`);
    await manager.query('INSERT INTO schema_versions(version,appliedAt) VALUES(19,?)',[Date.now()]);
  });}
  const [mcpContextVersion]=await db.query('SELECT MAX(version) version FROM schema_versions');
  if(mcpContextVersion.version<18){await db.transaction(async manager=>{
    const columns={sessionKey:'TEXT',nativeSessionId:'TEXT',nativeTurnId:'TEXT',runId:'TEXT',parentCallId:'TEXT',evidence:'TEXT'};
    const existing=await manager.query('PRAGMA table_info(mcp_calls)') as {name:string}[];
    for(const [name,type] of Object.entries(columns))if(!existing.some(c=>c.name===name))await manager.query(`ALTER TABLE mcp_calls ADD COLUMN ${name} ${type}`);
    await manager.query('CREATE INDEX IF NOT EXISTS mcp_calls_session ON mcp_calls(sessionKey,createdAt,id)');
    await manager.query('CREATE INDEX IF NOT EXISTS mcp_calls_run ON mcp_calls(runId,createdAt,id)');
    await manager.query('INSERT INTO schema_versions(version,appliedAt) VALUES(18,?)',[Date.now()]);
  });}
  const [mcpRepairVersion]=await db.query('SELECT MAX(version) version FROM schema_versions');
  if(mcpRepairVersion.version<20){await db.transaction(async manager=>{
    const columns={sessionKey:'TEXT',nativeSessionId:'TEXT',nativeTurnId:'TEXT',runId:'TEXT',parentCallId:'TEXT',evidence:'TEXT'};
    const existing=await manager.query('PRAGMA table_info(mcp_calls)') as {name:string}[];
    for(const [name,type] of Object.entries(columns))if(!existing.some(c=>c.name===name))await manager.query(`ALTER TABLE mcp_calls ADD COLUMN ${name} ${type}`);
    await manager.query('CREATE INDEX IF NOT EXISTS mcp_calls_session ON mcp_calls(sessionKey,createdAt,id)');
    await manager.query('CREATE INDEX IF NOT EXISTS mcp_calls_run ON mcp_calls(runId,createdAt,id)');
    await manager.query('INSERT INTO schema_versions(version,appliedAt) VALUES(20,?)',[Date.now()]);
  });}
  const [adaptiveVersion]=await db.query('SELECT MAX(version) version FROM schema_versions');
  if(adaptiveVersion.version<21){await db.transaction(async manager=>{
    await manager.query('CREATE TABLE IF NOT EXISTS adaptive_context_limits(providerId TEXT NOT NULL,model TEXT NOT NULL,protocol TEXT NOT NULL,learnedLimit INTEGER,lowerBound INTEGER NOT NULL DEFAULT 0,upperBound INTEGER,observations INTEGER NOT NULL DEFAULT 0,lastError TEXT,updatedAt INTEGER NOT NULL,PRIMARY KEY(providerId,model,protocol))');
    await manager.query('INSERT INTO schema_versions(version,appliedAt) VALUES(21,?)',[Date.now()]);
  });}
  const [aliasVersion]=await db.query('SELECT MAX(version) version FROM schema_versions');
  if(aliasVersion.version<22){await db.transaction(async manager=>{
    const existing=await manager.query('PRAGMA table_info(clients)') as {name:string}[];
    if(!existing.some(c=>c.name==="modelAliases"))await manager.query("ALTER TABLE clients ADD COLUMN modelAliases TEXT NOT NULL DEFAULT '[]'");
    await manager.query('INSERT INTO schema_versions(version,appliedAt) VALUES(22,?)',[Date.now()]);
  });}
  const [evictionVersion]=await db.query('SELECT MAX(version) version FROM schema_versions');
  if(evictionVersion.version<23){await db.transaction(async manager=>{
    const existing=await manager.query('PRAGMA table_info(request_captures)') as {name:string}[];
    // 淘汰时记录丢了哪些阶段（stage→bytes/chunks），因为同一条 UPDATE 会把 metadata 抹成 {}。
    if(!existing.some(c=>c.name==="evictedStages"))await manager.query("ALTER TABLE request_captures ADD COLUMN evictedStages TEXT NOT NULL DEFAULT '[]'");
    await manager.query('CREATE INDEX IF NOT EXISTS captures_state_created ON request_captures(state,createdAt)');
    await manager.query('INSERT INTO schema_versions(version,appliedAt) VALUES(23,?)',[Date.now()]);
  });}
  const [progressVersion]=await db.query('SELECT MAX(version) version FROM schema_versions');
  if(progressVersion.version<24){await db.transaction(async manager=>{
    const existing=await manager.query('PRAGMA table_info(traffic)') as {name:string}[];
    if(!existing.some(c=>c.name==="bytesTotal"))await manager.query('ALTER TABLE traffic ADD COLUMN bytesTotal INTEGER NOT NULL DEFAULT 0');
    if(!existing.some(c=>c.name==="progressAt"))await manager.query('ALTER TABLE traffic ADD COLUMN progressAt INTEGER');
    await manager.query('INSERT INTO schema_versions(version,appliedAt) VALUES(24,?)',[Date.now()]);
  });}
  const jobIndexVersion=await db.query('SELECT MAX(version) version FROM schema_versions');
  if(jobIndexVersion[0].version<25){await db.transaction(async manager=>{
    await manager.query('CREATE INDEX IF NOT EXISTS jobs_kind_history ON background_jobs(kind,status,createdAt)');
    await manager.query('INSERT INTO schema_versions(version,appliedAt) VALUES(25,?)',[Date.now()]);
  });}
  const trafficHeadersVersion=await db.query('SELECT MAX(version) version FROM schema_versions');
  if(trafficHeadersVersion[0].version<26){await db.transaction(async manager=>{
    const existing=await manager.query('PRAGMA table_info(traffic)') as {name:string}[];
    if(!existing.some(c=>c.name==="requestHeaders"))await manager.query("ALTER TABLE traffic ADD COLUMN requestHeaders TEXT NOT NULL DEFAULT '{}' ");
    await manager.query('INSERT INTO schema_versions(version,appliedAt) VALUES(26,?)',[Date.now()]);
  });}
  await db.query("UPDATE request_captures SET state='partial',reason='gateway_restarted',updatedAt=? WHERE state='recording'",[Date.now()]);
  await db.query("UPDATE asset_deployments SET status='uncertain',error='gateway_restarted',updatedAt=? WHERE status IN ('applying','restoring')",[Date.now()]);
  await db.query("UPDATE debug_attempts SET status='uncertain',error='gateway_restarted',endedAt=? WHERE status='running'",[Date.now()]);
  await db.query("UPDATE background_jobs SET status=CASE WHEN kind IN ('registry.scan','sessions.scan','sessions.search','sessions.timeline','provider.probe','mcp.probe','assets.scan','assets.search','assets.inspect','assets.snapshot','assets.preview','trajectory.snapshot','trajectory.cleanup') THEN 'queued' ELSE 'uncertain' END,phase='recovery',error='gateway_restarted',updatedAt=? WHERE status IN ('running','waiting')",[Date.now()]);
  await db.query("UPDATE route_sessions SET uncertain=1,leaseId=NULL,leaseExpiresAt=NULL WHERE leaseId IS NOT NULL");
  await db.query("UPDATE mcp_calls SET status=CASE WHEN status='running' THEN 'uncertain' ELSE 'cancelled' END,error='gateway_restarted',endedAt=?,updatedAt=? WHERE status IN ('pending','approved','running')", [Date.now(), Date.now()]);
  await db.query("UPDATE collection_sources SET state = 'idle' WHERE state = 'scanning'");
  await db.query("UPDATE run_approvals SET status = 'expired', updatedAt = ? WHERE status = 'pending'", [Date.now()]);
  await db.query("UPDATE clients SET enabled = 0 WHERE runId IS NOT NULL");
  await db.query("UPDATE runs SET status = 'paused', stopReason = 'gateway_restarted', leaseOwner = NULL, leaseExpiresAt = NULL, updatedAt = ? WHERE status IN ('queued','starting','running','evaluating','waiting_for_approval','waiting_for_input')", [Date.now()]);
  await db.query("UPDATE budget_reservations SET status = 'uncertain', costMicros = reservedMicros, tokens = reservedTokens WHERE status = 'held'");
  await db.getRepository(TrafficSchema).createQueryBuilder().update().set({ status: "failed", error: "gateway_restarted", updatedAt: Date.now() }).where("status = :status", { status: "running" }).execute();
}
export function record(): RecordBase { return { id: crypto.randomUUID(), createdAt: Date.now(), updatedAt: Date.now() }; }
export async function audit(action: string, subject: string, detail: Record<string, unknown> = {}) {
  await db.getRepository(AuditSchema).save({ ...record(), action, subject, detail });
}
const settingCache = new Map<string, { value: unknown; expiresAt: number }>();
export async function setting<T>(key: string, fallback: T): Promise<T> {
  const cached = settingCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value as T;
  const value = (await db.getRepository(SettingSchema).findOneBy({ id: key }))?.value as T ?? fallback;
  settingCache.set(key, { value, expiresAt: Date.now() + 5000 });
  return value;
}
export async function saveSetting(key: string, value: unknown) {
  await db.getRepository(SettingSchema).save({ ...record(), id: key, value });
  settingCache.delete(key);
}
