export type Protocol = "openai" | "anthropic" | "gemini";
export type WireProtocol = "responses" | "chat" | "messages" | "gemini";
export type Page = "overview" | "models" | "traffic" | "sessions" | "registry" | "persona" | "runs" | "settings" | "jobs" | "playground";
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
export interface ClientKey extends RecordBase {
  name: string; keyHash: string; keyPreview: string; enabled: boolean;
  project: string | null; personalize: boolean; routeIds: string[]; lastUsedAt: number | null;
  budgetMicros: number | null; tokenLimit: number | null; maxConcurrent: number; runId: string | null; expiresAt: number | null;
  mcpGrants: McpGrant[]; memoryAccess: boolean;
}
export type PublicClient = Omit<ClientKey, "keyHash">;
export interface Traffic extends RecordBase {
  clientId: string; clientName: string; routeId: string; model: string;
  providerId: string; providerName: string; protocol: WireProtocol;
  status: "running" | "completed" | "failed" | "cancelled";
  upstreamStatus: number | null; latencyMs: number | null; firstByteMs: number | null;
  inputTokens: number | null; outputTokens: number | null; costMicros: number | null;
  error: string | null; stream: boolean; project: string | null; patchIds: string[];
  runId: string | null; accounting: "pending" | "reported" | "estimated" | "unknown" | "rejected"; pricing: { input: number | null; output: number | null; cacheRead?: number | null; cacheWrite?: number | null; cacheWriteLong?: number | null };
  requestGroupId: string | null; affinityId: string | null; responseId: string | null;
  cacheReadTokens: number; cacheWriteTokens: number; cacheWriteLongTokens: number; reasoningTokens: number;
  decisions: { action: string; target?: string; reason: string }[];
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
  tokens: number; costMicros: number; unknownCost: number; latencyMs: number | null;
  series: { hour: string; count: number; failed: number }[];
  recent: Traffic[]; events: Audit[];
  providers: number; agents: number; skills: number; mcp: number; sessions: number; preferences: number;
}
export interface GatewayStatus {
  version: string; uptime: number; address: string; database: "sqlite";
  personalization: boolean; captureBodies: boolean;
}
export type RunStatus = "queued" | "starting" | "running" | "evaluating" | "waiting_for_input" | "waiting_for_approval" | "paused" | "blocked" | "budget_exhausted" | "completed" | "failed" | "cancelled";
export type RunAgent = "codex" | "claude" | "pi";
export interface CompletionFile { path: string; contains?: string }
export interface RunControls {
  mode: "turn" | "goal"; maxTurns: number; maxNoProgress: number;
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
export interface SessionList { items: Session[]; total: number; next: number | null }
export interface SessionTimeline { session: Session; events: SessionEvent[]; total: number; next: number | null; branches: { id: string; count: number }[] }
export interface McpGrant {
  connectionId: string; schemaHash: string; tools: string[]; resources: string[]; prompts: string[]; requireApproval: boolean;
}
export interface McpCall extends RecordBase {
  connectionId: string; connectionName: string; clientId: string | null; clientName: string; project: string | null;
  kind: "tool" | "resource" | "prompt"; name: string; schemaHash: string; requestCipher: string;
  status: "pending" | "approved" | "running" | "completed" | "rejected" | "cancelled" | "failed" | "uncertain";
  resultCipher: string | null; error: string | null; expiresAt: number; startedAt: number | null; endedAt: number | null;
}
export type PublicMcpCall = Omit<McpCall, "requestCipher" | "resultCipher">;
export interface McpCatalogRevision extends RecordBase {
  connectionId: string; hash: string; version: string | null;
  catalog: Pick<McpConnection, "tools" | "resources" | "prompts">;
}
export type JobKind = "registry.scan" | "sessions.scan" | "sessions.search" | "provider.probe" | "mcp.probe" | "model.debug" | "mcp.debug";
export interface BackgroundJob extends RecordBase {
  kind: JobKind; label: string; status: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "uncertain";
  payloadCipher: string; resultCipher: string | null; dedupKey: string | null;
  phase: string; processed: number; total: number | null; currentItem: string | null; attempts: number;
  nextRunAt: number; startedAt: number | null; endedAt: number | null; heartbeatAt: number | null;
  cancelRequested: boolean; error: string | null;
}
export type PublicJob = Omit<BackgroundJob, "payloadCipher" | "resultCipher" | "dedupKey">;
