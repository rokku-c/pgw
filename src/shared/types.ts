export type Protocol = "openai" | "anthropic" | "gemini" | "typesafe";
export type WireProtocol = "responses" | "chat" | "messages" | "gemini" | "systemone";
/** 互转时被丢弃的内容。`count` 在能界定边界的协议里是真实块数，chat/gemini 的匿名增量每类型至多记 1。 */
export interface ConversionDrop { type: string; count: number }
/** 互转降级开关：`reasoning` 丢弃推理块，`hosted` 忽略托管工具声明；两者默认为假时转换行为与关闭前逐字节相同。 */
export interface ConversionSink { reasoning: boolean; hosted: boolean; dropped: ConversionDrop[] }
export type Page = "overview" | "observability" | "models" | "traffic" | "sessions" | "registry" | "persona" | "runs" | "settings" | "jobs" | "playground";
export interface RecordBase { id: string; createdAt: number; updatedAt: number }
export interface Provider extends RecordBase {
  name: string; protocol: Protocol; baseUrl: string; secretCipher: string | null;
  enabled: boolean; health: "unknown" | "up" | "down"; latencyMs: number | null;
  lastChecked: number | null; lastError: string | null;
}
export type PublicProvider = Omit<Provider, "secretCipher"> & { hasSecret: boolean };
export interface Target { providerId: string; model: string; protocol?: WireProtocol; weight?: number; priority?: number; maxConcurrent?: number }
export interface ModelRoute extends RecordBase {
  alias: string; protocol: WireProtocol; targets: Target[]; enabled: boolean; strategy: "priority" | "round_robin" | "least_active";
  inputPrice: number | null; outputPrice: number | null; cacheReadPrice: number | null; cacheWritePrice: number | null; cacheWriteLongPrice: number | null; contextLimit: number; outputLimit: number;
}
/** 客户端级「模型别名 → 路由」映射。`name` 不限字符（要能接受 `deepseek-flash[1M]` 这类外部记法）；
 *  `name` 为 `*` 时是兜底：未匹配任何路由别名、也未匹配其它别名的请求名，都用该路由服务。 */
export interface ModelAlias { name: string; routeId: string }
export interface ClientKey extends RecordBase {
  name: string; kind: "long_term" | "temporary"; keyHash: string; keyPreview: string; enabled: boolean;
  project: string | null; personalize: boolean; routeIds: string[]; lastUsedAt: number | null;
  budgetMicros: number | null; tokenLimit: number | null; maxConcurrent: number; runId: string | null; expiresAt: number | null;
  mcpGrants: McpGrant[]; memoryAccess: boolean; modelAliases: ModelAlias[];
}
export type PublicClient = Omit<ClientKey, "keyHash">;
export interface Traffic extends RecordBase {
  requestHeaders: Record<string, string>;
  clientId: string; clientName: string; routeId: string; model: string;
  providerId: string; providerName: string; protocol: WireProtocol;
  status: "running" | "completed" | "failed" | "cancelled";
  upstreamStatus: number | null; latencyMs: number | null; firstByteMs: number | null; firstTokenMs: number | null; decodingMs: number | null;
  inputTokens: number | null; outputTokens: number | null; costMicros: number | null;
  error: string | null; stream: boolean; project: string | null; patchIds: string[];
  runId: string | null; accounting: "pending" | "reported" | "estimated" | "unknown" | "rejected"; pricing: { input: number | null; output: number | null; cacheRead?: number | null; cacheWrite?: number | null; cacheWriteLong?: number | null };
  requestGroupId: string | null; affinityId: string | null; responseId: string | null;
  cacheReadTokens: number; cacheWriteTokens: number; cacheWriteLongTokens: number; reasoningTokens: number;
  decisions: { action: string; target?: string; reason: string }[];
  /** 进行中的实时进度：已写出字节与最后一次进度落库时间（区别于 finish 才写的终值）。 */
  bytesTotal: number; progressAt: number | null;
}
export interface Preference extends RecordBase {
  title: string; content: string; scope: "global" | "project";
  project: string | null; status: "candidate" | "active" | "paused";
  source: "user" | "session"; evidence: string | null; revision: number;
}
export interface Asset extends RecordBase {
  kind: "agent" | "skill" | "mcp"; name: string; source: string; path: string;
  version: string | null; hash: string | null; description: string | null;
  status: "discovered" | "available" | "unavailable"; metadata: Record<string, unknown>;
}
export interface Session extends RecordBase {
  agent: string; nativeId: string; title: string; project: string | null;
  path: string; model: string | null; messageCount: number; lastActiveAt: number;
  size: number; cursor: number; status: "indexed" | "partial" | "error" | "missing" | "restricted";
  sourceId: string | null; generation: number; fileIdentity: string | null; prefixHash: string | null;
  fileMtime: number; parserVersion: number; eventCount: number; parseErrors: number; parentSessionId: string | null;
  lastError: string | null; captured: boolean; archived: boolean; starred: boolean; tags: string[];
}
export interface Audit extends RecordBase {
  action: string; subject: string; detail: Record<string, unknown>;
}
export interface Dashboard {
  requests: number; running: number; successRate: number | null;
  /** 实时：在途请求数（budget_reservations 的 held）与最近 60s 的请求/输出吞吐。 */
  active: number; qps: number; tps: number;
  tokens: number; inputTokens: number; outputTokens: number; reasoningTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costMicros: number; unknownCost: number; latencyMs: number | null; avgFirstTokenMs: number | null; avgDecodingMs: number | null; p95LatencyMs: number | null; modelCalls: number; toolCalls: number; retries: number;
  series: { hour: string; count: number; failed: number }[];
  recent: Traffic[]; events: Audit[];
  providers: number; agents: number; skills: number; mcp: number; sessions: number; preferences: number;
}
export interface GatewayStatus {
  version: string; apiVersion: number; uptime: number; address: string; database: "sqlite";
  personalization: boolean; captureBodies: boolean;
}
export type RunStatus = "queued" | "starting" | "running" | "evaluating" | "waiting_for_input" | "waiting_for_approval" | "paused" | "blocked" | "budget_exhausted" | "completed" | "failed" | "cancelled";
export type RunAgent = "codex" | "claude" | "pi";
export interface CompletionFile { path: string; contains?: string }
export type CoordinatorMode = "off" | "suggest" | "continue";
export interface RunControls {
  mode: "turn" | "goal"; maxTurns: number; maxNoProgress: number; coordinatorMode: CoordinatorMode;
  budgetMicros: number | null; tokenLimit: number | null;
  permission: "read-only" | "workspace-write"; completionFiles: CompletionFile[];
  mcpGrants?: McpGrant[]; memoryAccess?: boolean;
}
export interface Run extends RecordBase {
  agent: RunAgent; goal: string; workspace: string; routeId: string; status: RunStatus;
  output: string; exitCode: number | null; timeoutSeconds: number; endedAt: number | null;
  controls: RunControls; turnCount: number; nativeSessionId: string | null; nativeTurnId: string | null;
  clientId: string | null; elapsedMs: number; stopReason: string | null; progressHash: string | null;
  noProgressCount: number; leaseOwner: string | null; leaseExpiresAt: number | null;
}
export interface RunEvent extends RecordBase {
  runId: string; kind: string; turn: number; detail: Record<string, unknown>;
}
export interface RunApproval extends RecordBase {
  runId: string; requestId: string; kind: "command" | "file" | "input";
  method: string; payload: Record<string, unknown>;
  status: "pending" | "accepted" | "declined" | "expired"; response: Record<string, unknown> | null;
}
export interface BudgetSummary {
  costMicros: number; heldMicros: number; tokens: number; heldTokens: number;
  requests: number; uncertain: number; active: number;
}
export interface McpConnection extends RecordBase {
  name: string; transport: "stdio" | "http"; url: string | null; command: string | null;
  args: string[]; envCipher: string | null; headersCipher: string | null;
  enabled: boolean; status: "unknown" | "up" | "down"; version: string | null;
  tools: { name: string; description?: string; inputSchema: Record<string, unknown> }[];
  resources: { uri: string; name: string; description?: string; mimeType?: string }[];
  prompts: { name: string; description?: string; arguments?: { name: string; description?: string; required?: boolean }[] }[];
  capabilities: Record<string, unknown>; schemaHash: string | null; previousSchemaHash: string | null;
  lastChecked: number | null; lastError: string | null;
}
export type PublicMcpConnection = Omit<McpConnection, "envCipher" | "headersCipher"> & { hasEnv: boolean; hasHeaders: boolean };
export interface CollectionSource extends RecordBase {
  name: string; agent: "claude" | "codex" | "pi" | "auto"; path: string; enabled: boolean;
  captureBodies: boolean; learn: boolean; revision: number; lastScanAt: number | null;
  lastError: string | null; fileCount: number; state: "idle" | "scanning" | "error";
}
export interface SessionEvent extends RecordBase {
  sessionId: string; generation: number; sourceKey: string; nativeId: string | null; parentId: string | null;
  kind: "message" | "tool_call" | "tool_result" | "compaction" | "branch" | "metadata" | "unknown" | "parse_error";
  role: "user" | "assistant" | "tool" | "system" | "unknown"; origin: "user" | "assistant" | "tool" | "system" | "unknown";
  text: string | null; metadata: Record<string, unknown>; offset: number; endOffset: number; timestamp: number | null;
}
export interface PreferenceRevision extends RecordBase {
  preferenceId: string; revision: number; title: string; content: string; scope: "global" | "project";
  project: string | null; status: "candidate" | "active" | "paused"; reason: string;
}
export interface PreferenceEvidence extends RecordBase {
  preferenceId: string; eventId: string | null; sourceId: string | null; sessionId: string | null;
  excerpt: string; kind: "explicit" | "inferred" | "correction" | "counterexample"; confidence: number;
}
export interface SessionList { unavailable?: number; items: Session[]; total: number; next: number | null }
export interface SessionTimeline { session: Session; events: SessionEvent[]; total: number; next: number | null; branches: { id: string; count: number }[] }
export interface McpGrant {
  connectionId: string; schemaHash: string; tools: string[]; resources: string[]; prompts: string[]; requireApproval: boolean;
}
export interface McpCall extends RecordBase {
  connectionId: string; connectionName: string; clientId: string | null; clientName: string; project: string | null;
  kind: "tool" | "resource" | "prompt"; name: string; schemaHash: string; requestCipher: string;
  sessionKey: string | null; nativeSessionId: string | null; nativeTurnId: string | null; runId: string | null; parentCallId: string | null; evidence: string | null;
  status: "pending" | "approved" | "running" | "completed" | "rejected" | "cancelled" | "failed" | "uncertain";
  resultCipher: string | null; error: string | null; expiresAt: number; startedAt: number | null; endedAt: number | null;
}
export type PublicMcpCall = Omit<McpCall, "requestCipher" | "resultCipher">;
export interface McpCatalogRevision extends RecordBase {
  connectionId: string; hash: string; version: string | null;
  catalog: Pick<McpConnection, "tools" | "resources" | "prompts">;
}
export type JobKind = "trajectory.snapshot" | "trajectory.cleanup" | "registry.scan" | "sessions.scan" | "sessions.search" | "sessions.timeline" | "provider.probe" | "mcp.probe" | "model.debug" | "mcp.debug" | "assets.scan" | "assets.search" | "assets.inspect" | "assets.snapshot" | "assets.preview" | "assets.apply" | "assets.restore";
export interface BackgroundJob extends RecordBase {
  kind: JobKind; label: string; status: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "uncertain";
  payloadCipher: string; resultCipher: string | null; dedupKey: string | null;
  phase: string; processed: number; total: number | null; currentItem: string | null; attempts: number;
  nextRunAt: number; startedAt: number | null; endedAt: number | null; heartbeatAt: number | null;
  cancelRequested: boolean; error: string | null;
}
export type PublicJob = Omit<BackgroundJob, "payloadCipher" | "resultCipher" | "dedupKey">;
export interface AssetRoot extends RecordBase {
  name:string; path:string; agent:"claude"|"codex"|"pi"|"shared"; project:string|null;
  enabled:boolean; followSymlinks:boolean; capture:boolean; revision:number;
  lastScanAt:number|null; lastError:string|null; count:number;
}
export interface PackageFile { path:string; hash:string; size:number; executable:boolean; mode?:number; content:string }
export interface SkillPackage { files:PackageFile[]; hash:string; bytes:number; directories?:{path:string;mode:number}[] }
export interface AssetSnapshot extends RecordBase { assetId:string; hash:string; bytes:number; files:{path:string;hash:string;size:number;executable:boolean}[]; contentCipher:string; version:string|null }
export interface AssetDeployment extends RecordBase {
  assetId:string; snapshotId:string; target:string; targetRoot:string; agent:string;
  status:"prepared"|"applying"|"applied"|"restoring"|"restored"|"failed"|"uncertain";
  beforeHash:string|null; afterHash:string; beforeCipher:string|null; afterCipher:string;
  stagePath:string|null; error:string|null; diff:{path:string;action:"add"|"change"|"remove"}[];
}

export interface AdaptiveContextPolicy {
  enabled: boolean; learn: boolean; compressionEnabled: boolean; compressionRatio: number;
  maxTokens: number | null; awarenessPrompt: string;
}
export interface RetryPolicy { enabled: boolean; maxRetries: number | null; backoffMs: number; statuses: number[] }
export interface GatewayPolicies { adaptiveContext: AdaptiveContextPolicy; protocolConversion: boolean; transparentRetry: RetryPolicy }
export interface CapturePolicy { enabled:boolean; revision:number; retentionDays:number; maxStageBytes:number; maxStorageBytes:number }
export type CaptureStage = "request" | "effective" | "upstream" | "response" | "output";
/** 可清理的数据分类；配置类不在此列，界面上不可选中。 */
export type StorageCategory = "sessions"|"captures"|"snapshots"|"jobs"|"runs"|"assets"|"mcp"|"traffic"|"audit"|"transient";
export interface StorageUsage { totalBytes:number; configBytes:number; otherBytes:number; categories:{id:StorageCategory;bytes:number}[] }
export interface CaptureStageUsage { stage:CaptureStage;bytes:number;chunks:number }
export interface CaptureInfo {
  requestId:string; requestGroupId:string; state:"recording"|"complete"|"partial"|"expired"|"deleted"|"not_captured";
  createdAt:number; updatedAt:number; expiresAt:number; bytes:number; reason:string|null;
  metadata:Record<string,unknown>; stages:CaptureStageUsage[];
  /** 已因配额被淘汰的阶段与体量。行本身（state/reason/时间/分组）始终保留，这里说明内容丢了什么。 */
  evictedStages:CaptureStageUsage[];
}
export interface CapturePage { text:string; next:number|null; bytes:number; complete:boolean; fallback?:boolean }

export interface ObservabilityEvent { id:string; at:number; kind:"session"|"model_call"|"managed_session"|"tool_call"|"job"|"scan"; title:string; status:string; sessionId:string|null; runId:string|null; trafficId:string|null; details:Record<string,unknown> }
export interface ObservabilitySnapshot { id:string; createdAt:number; updatedAt:number; label:string; hash:string; summary:{sessions:number;modelCalls:number;managedSessions:number;tools:number;jobs:number}; }
export interface SnapshotDiffItem { path:string; action:"add"|"remove"|"change"; before?:unknown; after?:unknown }
