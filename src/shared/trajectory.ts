import type { CaptureStage } from "./types";

export type TrajectorySection =
  "system" | "messages" | "tools" | "config" | "transport" | "output" | "other";
export interface TrajectoryBlock {
  id: string;
  section: TrajectorySection;
  kind:
    | "text"
    | "reasoning"
    | "message"
    | "tool_call"
    | "tool_result"
    | "tool_schema"
    | "value";
  role: string | null;
  name: string | null;
  callId: string | null;
  value: unknown;
}
export type TrajectoryCoverage =
  "complete" | "recording" | "partial" | "not_captured" | "expired" | "deleted";
export interface TrajectoryProjection {
  blocks: TrajectoryBlock[];
  format: "json" | "sse" | "text";
  warnings: string[];
}
export interface TrajectoryWindow {
  requestId: string;
  stage: CaptureStage | "node";
  sourceStage: CaptureStage | "node";
  coverage: TrajectoryCoverage;
  reason: string | null;
  format: TrajectoryProjection["format"];
  warnings: string[];
  sections: { name: TrajectorySection; count: number }[];
  blocks: (Omit<TrajectoryBlock, "value"> & {
    preview: string;
    length: number;
    truncated: boolean;
  })[];
  total: number;
  next: number | null;
}
export interface TrajectoryChange {
  section: string;
  path: string;
  action: "add" | "remove" | "change";
  before?: unknown;
  after?: unknown;
}

export interface TrajectoryEvidence {
  certainty: "explicit" | "derived" | "candidate";
  source: string;
  scope: string;
  confidence: number | null;
}
export interface TrajectorySession {
  key: string;
  kind: "scanned" | "managed" | "independent";
  title: string;
  agent: string | null;
  nativeId: string | null;
  project: string | null;
  status: string;
  at: number;
  sourceId: string | null;
  parentId: string | null;
  calls: number;
  events: number;
  evidence: TrajectoryEvidence;
}
export interface TrajectoryNode {
  id: string;
  kind:
    | "model_call"
    | "message"
    | "tool_call"
    | "tool_result"
    | "compaction"
    | "branch"
    | "runtime"
    | "approval"
    | "metadata";
  title: string;
  status: string;
  at: number | null;
  turn: string | null;
  turnEvidence: "explicit" | "derived" | "unknown";
  step: string | null;
  parentId: string | null;
  role: string | null;
  durationMs: number | null;
  firstByteMs: number | null;
  firstTokenMs: number | null;
  decodingMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  requestId: string | null;
  relations: (TrajectoryEvidence & {
    relation: "tool_result_of" | "attempt_of";
    target: string;
    callId: string | null;
  })[];
  source: {
    kind: "traffic" | "session_event" | "run_event" | "approval" | "mcp_call";
    id: string;
  };
}
export interface TrajectorySessionPage {
  items: TrajectorySession[];
  next: string | null;
}
export interface TrajectoryNodePage {
  session: TrajectorySession;
  items: TrajectoryNode[];
  next: number | null;
  total: number;
  revision: string;
  links: (TrajectoryEvidence & { key: string; title: string })[];
}

export type ContextSnapshotKind = TrajectoryNode["source"]["kind"];
export interface ContextSnapshot {
  id: string;
  createdAt: number;
  expiresAt: number;
  label: string;
  hash: string;
  sessionKey: string;
  nodeKind: ContextSnapshotKind;
  nodeId: string;
  state: "writing" | "ready" | "failed" | "deleted" | "expired";
  bytes: number;
  coverage: TrajectoryCoverage;
  stages: {
    name: CaptureStage | "node";
    coverage: TrajectoryCoverage;
    bytes: number;
    hash: string;
    reason: string | null;
  }[];
}
export interface ContextSnapshotPage {
  items: ContextSnapshot[];
  next: number | null;
}
