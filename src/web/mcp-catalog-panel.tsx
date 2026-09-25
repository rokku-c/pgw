import { useEffect, useState } from "react";
import { ArrowClockwise, Check, Heartbeat, X } from "@phosphor-icons/react";
import { get, send } from "./api";
import { Button, ContentBlock, DataTable, DetailHeader, ErrorBox, Field, Loading, Modal, Panel, Section, Stack, StatusBadge, Toolbar } from "./components";

type AnyRecord = Record<string, any>;

function errorText(reason: unknown) { return reason instanceof Error ? reason.message : "Request failed"; }
function date(value: unknown) { const number = Number(value); return Number.isFinite(number) && number > 0 ? new Date(number).toLocaleString() : "—"; }
function tone(value: unknown) { const text = String(value ?? "unknown"); return <StatusBadge tone={["up", "ready", "completed"].includes(text) ? "success" : ["failed", "down", "error"].includes(text) ? "danger" : "warning"}>{text}</StatusBadge>; }

async function pollJob(response: AnyRecord) {
  const id = response?.job?.id;
  if (!id) return response?.result || response;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const job = await get<AnyRecord>(`/jobs/${encodeURIComponent(id)}`);
    if (["completed", "failed", "cancelled", "uncertain"].includes(String(job.status))) {
      if (job.status !== "completed") throw new Error(job.error || `Job ${job.status}`);
      return job.result || job;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Job timed out");
}

export function McpCatalogPanel({ data, selected, onSelect, onRefresh, onError }: { data: AnyRecord[]; selected?: AnyRecord; onSelect: (value?: AnyRecord) => void; onRefresh: () => void; onError: (value: string) => void }) {
  return <><Panel><div className="panel-header"><h2>MCP connections</h2><span className="muted">Select a connection to inspect its catalog.</span></div><DataTable rows={data} empty="No MCP connections" onRowClick={onSelect} columns={[{ key: "name", label: "Name" }, { key: "transport", label: "Transport" }, { key: "status", label: "Status", render: (row) => tone(row.status) }, { key: "enabled", label: "Enabled", render: (row) => <label className="switch"><input type="checkbox" checked={Boolean(row.enabled)} onChange={async (event) => { try { await send(`/mcp/${encodeURIComponent(String(row.id))}`, "PATCH", { enabled: event.target.checked }); onRefresh(); } catch (reason) { onError(errorText(reason)); } }} />{row.enabled ? "On" : "Off"}</label> }]} /></Panel><McpCatalogModal value={selected} onClose={() => onSelect()} onRefresh={onRefresh} onError={onError} /></>;
}

function McpCatalogModal({ value, onClose, onRefresh, onError }: { value?: AnyRecord; onClose: () => void; onRefresh: () => void; onError: (value: string) => void }) {
  const [history, setHistory] = useState<AnyRecord[]>();
  const [kind, setKind] = useState("call");
  const [name, setName] = useState("");
  const [argumentsJson, setArgumentsJson] = useState("{}");
  const [result, setResult] = useState<AnyRecord>();
  const [error, setError] = useState("");
  useEffect(() => { setHistory(undefined); setResult(undefined); setError(""); setName(""); setArgumentsJson("{}"); }, [value]);
  const execute = async () => { if (!value || !name.trim()) return; try { setError(""); const response = await pollJob(await send(`/mcp/${encodeURIComponent(String(value.id))}/${kind}`, "POST", { name, arguments: JSON.parse(argumentsJson), confirmed: true })); setResult(response); onRefresh(); } catch (reason) { setError(reason instanceof SyntaxError ? "Arguments must be valid JSON." : errorText(reason)); } };
  const loadHistory = async () => { if (!value) return; try { setHistory(await get(`/mcp/${encodeURIComponent(String(value.id))}/history`)); } catch (reason) { setError(errorText(reason)); } };
  return <Modal title={value?.name || "MCP catalog"} open={Boolean(value)} onOpenChange={(open) => !open && onClose()} wide>{value ? <Stack className="reading-flow"><DetailHeader eyebrow="MCP CATALOG" title={String(value.name || value.id)} onBack={onClose} actions={<Toolbar><Button onClick={async () => { try { await pollJob(await send(`/mcp/${encodeURIComponent(String(value.id))}/probe`, "POST")); onRefresh(); } catch (reason) { onError(errorText(reason)); } }}><Heartbeat size={14} />Probe</Button><Button onClick={loadHistory}><ArrowClockwise size={14} />History</Button></Toolbar>} /><ErrorBox error={error} /><Section title="Catalog"><div className="detail-list"><div><span>Tools</span><strong>{String(value.tools?.length || 0)}</strong></div><div><span>Resources</span><strong>{String(value.resources?.length || 0)}</strong></div><div><span>Prompts</span><strong>{String(value.prompts?.length || 0)}</strong></div><div><span>Status</span><strong>{tone(value.status)}</strong></div></div></Section><Section title="Execute"><Field label="Debug kind"><select value={kind} onChange={(event) => setKind(event.target.value)}><option value="call">Tool</option><option value="resource">Resource</option><option value="prompt">Prompt</option></select></Field><Field label="Name"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Catalog item name" /></Field><Field label="Arguments JSON"><textarea className="mono full" rows={5} value={argumentsJson} onChange={(event) => setArgumentsJson(event.target.value)} /></Field><Button variant="primary" disabled={!name.trim()} onClick={execute}><Check size={14} />Execute</Button></Section>{result ? <Section title="Result"><ContentBlock value={result} /></Section> : null}{history ? <Section title="History"><DataTable rows={history} empty="No catalog history" columns={[{ key: "version", label: "Version" }, { key: "hash", label: "Hash" }, { key: "createdAt", label: "Created", render: (row) => date(row.createdAt) }, { key: "catalog", label: "Catalog", render: (row) => <ContentBlock value={row.catalog} allowRaw={false} /> }]} /></Section> : null}</Stack> : <Loading />}</Modal>;
}
