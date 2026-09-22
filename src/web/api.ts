import { tr, isMessageKey, formatNumber, formatMoney, formatBytes, formatRelative, type I18nKey } from "./i18n";
import { useCallback, useEffect, useState } from "react";

export class RequestError extends Error {
  constructor(public code: string, public status: number) { super(code); }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, { ...options, headers: { "content-type": "application/json", ...options.headers } });
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("pgw:unauthorized"));
    throw new RequestError(body.error?.code || "request_failed", response.status);
  }
  if(response.status===202 && body.job){
    window.dispatchEvent(new Event("pgw:jobs"));
    const id=body.job.id;
    try {
      while(true){
        if(options.signal?.aborted)throw new DOMException("Aborted","AbortError");
        await new Promise(resolve=>setTimeout(resolve,350));
        const job=await api<any>(`/jobs/${id}`,{signal:options.signal});
        if(job.status==="completed")return job.result as T;
        if(["failed","cancelled","uncertain"].includes(job.status))throw new RequestError(job.error||job.status,409);
      }
    }finally{
      if(options.signal?.aborted&&["sessions.search","sessions.timeline","assets.search"].includes(body.job.kind))void fetch(`/api/jobs/${id}/cancel`,{method:"POST",headers:{"content-type":"application/json"}}).catch(()=>{});
    }
  }
  return body;
}
export async function submit(path:string,body:unknown) {
  const response=await fetch(`/api${path}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const value=await response.json();if(!response.ok)throw new RequestError(value.error?.code||"request_failed",response.status);
  window.dispatchEvent(new Event("pgw:jobs"));return value.job as import("../shared/types").PublicJob;
}
export function useResource<T>(path: string, interval = 0) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try { const value = await api<T>(path, { signal: controller.signal }); if (!controller.signal.aborted) { setData(value); setError(undefined); } }
      catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "request_failed"); }
      finally { pending = false; if (!controller.signal.aborted) setLoading(false); }
    };
    void load();
    const timer = interval ? setInterval(() => { if (document.visibilityState === "visible") void load(); }, interval) : undefined;
    return () => { controller.abort(); clearInterval(timer); };
  }, [path, interval, revision]);
  return { data, error, loading, refresh };
}
export const errors: Record<string, I18nKey> = {
  snapshot_expired:"error.snapshotExpired",snapshot_not_ready:"error.snapshotNotReady",snapshot_body_missing:"error.snapshotBodyMissing",snapshot_source_active:"error.snapshotSourceActive",snapshot_storage_limit:"error.snapshotStorageLimit",snapshot_file_changed:"error.snapshotChanged",snapshot_file_missing:"error.snapshotChanged",snapshot_scope_mismatch:"error.snapshotScope",snapshot_too_large:"error.snapshotTooLarge",snapshot_context_required:"error.snapshotContext",
  target_not_skill:"error.targetNotSkill",asset_source_disabled:"error.assetDisabled",package_size_limit:"error.packageSize",package_directory_limit:"error.packageSize",package_symlink_requires_review:"error.packageLink",package_hardlink_requires_review:"error.packageLink",target_changed:"error.targetChanged",target_root_missing:"error.targetRootMissing",invalid_skill_directory:"error.skillDirectory",deployment_state_changed:"error.deploymentState",
  budget_exhausted: "error.budget", token_budget_exhausted: "error.tokens", price_required: "error.prices", concurrency_limit: "error.concurrency", run_not_active: "error.runEnded", extend_limits_required: "error.extendLimits", agent_not_installed: "error.agentMissing", invalid_workspace: "error.workspaceMissing", approval_expired: "error.approvalExpired", steering_not_supported: "error.steering", run_not_resumable: "error.resume",
  session_file_missing:"error.sessionFileMissing",session_file_changed:"error.sessionFileChanged",source_path_escape:"error.sourceChanged",
  source_overlap: "error.sourceOverlap", source_missing: "error.directoryMissing", source_exists: "error.sourceExists", source_changed: "error.sourceChanged", pause_source_before_moving: "error.pauseSource", capture_required: "error.captureRequired", source_too_broad: "error.sourceBroad", absolute_path_required: "error.absolutePath", evidence_not_authorized: "error.evidenceScope",
  catalog_changed: "error.catalogChanged", upstream_catalog_changed: "error.upstreamCatalog", mcp_scope_denied: "error.mcpScope", invalid_tool_arguments: "error.toolArguments", mcp_disabled: "error.mcpDisabled", call_not_active: "error.callEnded", mcp_concurrency_limit: "error.toolConcurrency", tool_rejected: "error.toolRejected",
  invalid_token: "error.credentials", invalid_input: "error.input", provider_in_use: "error.providerUsed", protocol_mismatch: "error.protocol",
  alias_exists: "error.aliasExists", project_required: "error.project", unauthorized: "error.authentication", internal_error: "error.operation", origin_denied: "error.origin",
};
export function errorKey(error: unknown): I18nKey {
  const code=error instanceof Error?error.message:String(error);
  return isMessageKey(code)?code:errors[code]||"error.retry";
}
export const errorText = (error: unknown) => tr(errorKey(error));
export const number = formatNumber;
export const money = formatMoney;
export const bytes = formatBytes;
export const relative = formatRelative;
