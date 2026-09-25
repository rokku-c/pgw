import { useEffect, useState } from "react";
import { ArrowsClockwise, Broadcast, Check, FlowArrow, Package, PencilSimple, Play, Plus, Pulse, ShieldCheck, Stop, Trash, X } from "@phosphor-icons/react";
import { get, send } from "./api";
import { Button, Confirm, ContentBlock, DataTable, DetailHeader, EmptyState, ErrorBox, Field, Loading, Modal, PageHeader, Panel, Section, Stack, StatusBadge, Toolbar } from "./components";

type AnyRecord = Record<string, any>;

function errorText(reason: unknown) { return reason instanceof Error ? reason.message : "Request failed"; }
function date(value: unknown) { const number = Number(value); return Number.isFinite(number) && number > 0 ? new Date(number).toLocaleString() : "—"; }
function rows(value: unknown): AnyRecord[] { return Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as AnyRecord).items) ? (value as AnyRecord).items : []; }
function tone(value: unknown) { const text = String(value ?? "unknown"); const positive = ["approved", "accepted", "completed", "running", "open", "healthy"]; const negative = ["rejected", "cancelled", "failed", "closed", "down"]; return <StatusBadge tone={positive.includes(text) ? "success" : negative.includes(text) ? "danger" : "warning"}>{text}</StatusBadge>; }

function useResource<T>(path: string) {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    void get<T>(path).then((value) => { if (!cancelled) setData(value); }).catch((reason) => { if (!cancelled) setError(errorText(reason)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path, version]);
  return { data, loading, error, refresh: () => setVersion((value) => value + 1) };
}

export function ControlPage() {
  const [tab, setTab] = useState<"approvals" | "mcp" | "routing" | "registry">("approvals");
  const tabs = [["approvals", "Approvals", ShieldCheck], ["mcp", "MCP calls", Broadcast], ["routing", "Routing state", FlowArrow], ["registry", "Registry controls", Package]] as const;
  return <Stack>
    <PageHeader icon={ShieldCheck} title="Control" description="Review pending actions, make MCP decisions, and reset routing state safely." />
    <div className="tabs">{tabs.map(([id, label, Icon]) => <button type="button" key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}><Icon size={15} />{label}</button>)}</div>
    {tab === "approvals" ? <ApprovalsPanel /> : null}
    {tab === "mcp" ? <McpCallsPanel /> : null}
    {tab === "routing" ? <RoutingPanel /> : null}
    {tab === "registry" ? <RegistryControlsPanel /> : null}
  </Stack>;
}

function ApprovalsPanel() {
  const resource = useResource<AnyRecord[]>("/approvals");
  const [error, setError] = useState("");
  const decide = async (id: string, accept: boolean) => { try { await send(`/approvals/${encodeURIComponent(id)}`, "POST", { accept }); resource.refresh(); } catch (reason) { setError(errorText(reason)); } };
  return <Stack><ErrorBox error={error || resource.error} /><Panel><div className="panel-header"><div><h2>Pending approvals</h2><span className="muted">Review before an agent or tool continues.</span></div><Button onClick={resource.refresh}><ArrowsClockwise size={15} />Refresh</Button></div>{resource.loading ? <Loading /> : <DataTable rows={rows(resource.data)} empty="No pending approvals" columns={[{ key: "kind", label: "Kind" }, { key: "title", label: "Request" }, { key: "status", label: "Status", render: (row) => tone(row.status || "pending") }, { key: "createdAt", label: "Created", render: (row) => date(row.createdAt) }, { key: "actions", label: "Actions", render: (row) => <Toolbar><Button variant="primary" onClick={() => decide(String(row.id), true)}><Check size={14} />Approve</Button><Button variant="danger" onClick={() => decide(String(row.id), false)}><X size={14} />Deny</Button></Toolbar> }]} />}</Panel></Stack>;
}

function McpCallsPanel() {
  const [status, setStatus] = useState("");
  const resource = useResource<AnyRecord[]>(`/mcp-calls${status ? `?status=${encodeURIComponent(status)}` : ""}`);
  const [selected, setSelected] = useState<AnyRecord>();
  const [error, setError] = useState("");
  const decide = async (id: string, accept: boolean) => { try { await send(`/mcp-calls/${encodeURIComponent(id)}/decide`, "POST", { accept }); resource.refresh(); setSelected(undefined); } catch (reason) { setError(errorText(reason)); } };
  const cancel = async (id: string) => { try { await send(`/mcp-calls/${encodeURIComponent(id)}/cancel`, "POST"); resource.refresh(); setSelected(undefined); } catch (reason) { setError(errorText(reason)); } };
  return <Stack><ErrorBox error={error || resource.error} /><Panel><div className="panel-header"><div><h2>MCP calls</h2><span className="muted">Approve, reject, cancel, and inspect tool calls.</span></div><Toolbar><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option>{["pending", "approved", "running", "completed", "rejected", "cancelled", "failed", "uncertain"].map((value) => <option key={value} value={value}>{value}</option>)}</select><Button onClick={resource.refresh}><ArrowsClockwise size={15} />Refresh</Button></Toolbar></div>{resource.loading ? <Loading /> : <DataTable rows={rows(resource.data)} empty="No MCP calls" onRowClick={setSelected} columns={[{ key: "serverName", label: "Server" }, { key: "method", label: "Method" }, { key: "name", label: "Name" }, { key: "status", label: "Status", render: (row) => tone(row.status) }, { key: "createdAt", label: "Created", render: (row) => date(row.createdAt) }]} />}</Panel><McpCallDetail value={selected} onClose={() => setSelected(undefined)} onDecide={decide} onCancel={cancel} /></Stack>;
}

function McpCallDetail({ value, onClose, onDecide, onCancel }: { value?: AnyRecord; onClose: () => void; onDecide: (id: string, accept: boolean) => void; onCancel: (id: string) => void }) {
  const [detail, setDetail] = useState<AnyRecord>();
  const [error, setError] = useState("");
  useEffect(() => { if (!value) return; setDetail(undefined); void get<AnyRecord>(`/mcp-calls/${encodeURIComponent(String(value.id))}`).then(setDetail).catch((reason) => setError(errorText(reason))); }, [value]);
  const current = detail || value;
  return <Modal title={current?.name || "MCP call"} open={Boolean(value)} onOpenChange={(open) => !open && onClose()} wide>{!current ? null : <Stack className="reading-flow"><DetailHeader eyebrow="MCP CALL" title={String(current.name || current.method || current.id)} description={<span className="mono break-anywhere">{String(current.id || "")}</span>} onBack={onClose} actions={<Toolbar>{current.status === "pending" ? <><Button variant="primary" onClick={() => onDecide(String(current.id), true)}><Check size={14} />Approve</Button><Button variant="danger" onClick={() => onDecide(String(current.id), false)}><X size={14} />Deny</Button></> : null}{["pending", "approved", "running"].includes(String(current.status)) ? <Confirm title="Cancel MCP call" onConfirm={() => onCancel(String(current.id))}><Button variant="danger"><Stop size={14} />Cancel</Button></Confirm> : null}</Toolbar>} /><ErrorBox error={error} /><Section title="Summary"><div className="detail-list"><div><span>Status</span><strong>{tone(current.status)}</strong></div><div><span>Server</span><strong>{String(current.serverName || current.serverId || "—")}</strong></div><div><span>Method</span><strong>{String(current.method || "—")}</strong></div><div><span>Created</span><strong>{date(current.createdAt)}</strong></div></div></Section><Section title="Arguments"><ContentBlock value={current.arguments || current.request || {}} /></Section><Section title="Result"><ContentBlock value={current.result || current.error || {}} /></Section></Stack>}</Modal>;
}

function RoutingPanel() {
  const sessions = useResource<AnyRecord[]>("/routing/sessions");
  const circuits = useResource<AnyRecord[]>("/routing/circuits");
  const [error, setError] = useState("");
  const refresh = () => { sessions.refresh(); circuits.refresh(); };
  return <Stack><ErrorBox error={error || sessions.error || circuits.error} /><Panel><div className="panel-header"><div><h2>Routing sessions</h2><span className="muted">Clear sticky route state when a client gets stuck.</span></div><Button onClick={refresh}><ArrowsClockwise size={15} />Refresh</Button></div>{sessions.loading ? <Loading /> : <DataTable rows={rows(sessions.data)} empty="No routing sessions" columns={[{ key: "clientId", label: "Client" }, { key: "routeId", label: "Route" }, { key: "providerId", label: "Provider" }, { key: "updatedAt", label: "Updated", render: (row) => date(row.updatedAt) }, { key: "actions", label: "Actions", render: (row) => <Confirm title="Delete routing session" onConfirm={async () => { try { await send(`/routing/sessions/${encodeURIComponent(String(row.id))}`, "DELETE"); sessions.refresh(); } catch (reason) { setError(errorText(reason)); } }}><Button variant="danger"><Trash size={14} />Clear</Button></Confirm> }]} />}</Panel><Panel><div className="panel-header"><div><h2>Provider circuits</h2><span className="muted">Reset a circuit after recovering an upstream provider.</span></div></div>{circuits.loading ? <Loading /> : <DataTable rows={rows(circuits.data)} empty="No provider circuits" columns={[{ key: "providerName", label: "Provider" }, { key: "state", label: "State", render: (row) => tone(row.state) }, { key: "failures", label: "Failures" }, { key: "updatedAt", label: "Updated", render: (row) => date(row.updatedAt) }, { key: "actions", label: "Actions", render: (row) => <Button onClick={async () => { try { await send(`/routing/circuits/${encodeURIComponent(String(row.id))}/reset`, "POST"); circuits.refresh(); } catch (reason) { setError(errorText(reason)); } }}><Pulse size={14} />Reset</Button> }]} />}</Panel></Stack>;
}

function RegistryControlsPanel() {
  const roots = useResource<AnyRecord[]>("/asset-roots");
  const connections = useResource<AnyRecord[]>("/mcp");
  const [rootEditor, setRootEditor] = useState<AnyRecord | null | false>(false);
  const [mcpEditor, setMcpEditor] = useState<AnyRecord | null | false>(false);
  const [error, setError] = useState("");
  const refresh = () => { roots.refresh(); connections.refresh(); };
  return <Stack><ErrorBox error={error || roots.error || connections.error} /><Panel><div className="panel-header"><div><h2>Asset roots</h2><span className="muted">Create, edit, scan, and disable skill roots.</span></div><Toolbar><Button variant="primary" onClick={() => setRootEditor(null)}><Plus size={14} />Add root</Button><Button onClick={roots.refresh}><ArrowsClockwise size={15} />Refresh</Button></Toolbar></div>{roots.loading ? <Loading /> : <DataTable rows={rows(roots.data)} empty="No asset roots" columns={[{ key: "name", label: "Name" }, { key: "agent", label: "Agent" }, { key: "path", label: "Path" }, { key: "enabled", label: "State", render: (row) => tone(row.enabled ? "enabled" : "disabled") }, { key: "actions", label: "Actions", render: (row) => <Toolbar><Button onClick={async () => { try { await send(`/asset-roots/${encodeURIComponent(String(row.id))}/scan`, "POST"); roots.refresh(); } catch (reason) { setError(errorText(reason)); } }}><Play size={14} />Scan</Button><Button onClick={() => setRootEditor(row)}><PencilSimple size={14} />Edit</Button></Toolbar> }]} />}</Panel><Panel><div className="panel-header"><div><h2>MCP connections</h2><span className="muted">Manage native HTTP and stdio connections.</span></div><Toolbar><Button variant="primary" onClick={() => setMcpEditor(null)}><Plus size={14} />Add connection</Button><Button onClick={connections.refresh}><ArrowsClockwise size={15} />Refresh</Button></Toolbar></div>{connections.loading ? <Loading /> : <DataTable rows={rows(connections.data)} empty="No MCP connections" columns={[{ key: "name", label: "Name" }, { key: "transport", label: "Transport" }, { key: "status", label: "Status", render: (row) => tone(row.status) }, { key: "enabled", label: "State", render: (row) => <label className="switch"><input type="checkbox" checked={Boolean(row.enabled)} onChange={async (event) => { try { await send(`/mcp/${encodeURIComponent(String(row.id))}`, "PATCH", { enabled: event.target.checked }); connections.refresh(); } catch (reason) { setError(errorText(reason)); } }} />{row.enabled ? "Enabled" : "Disabled"}</label> }, { key: "actions", label: "Actions", render: (row) => <Confirm title="Delete MCP connection" onConfirm={async () => { try { await send(`/mcp/${encodeURIComponent(String(row.id))}`, "DELETE"); connections.refresh(); } catch (reason) { setError(errorText(reason)); } }}><Button variant="danger"><Trash size={14} /></Button></Confirm> }]} />}</Panel><RootEditor value={rootEditor} open={rootEditor !== false} onClose={() => setRootEditor(false)} onSaved={() => { setRootEditor(false); roots.refresh(); }} onError={setError} /><McpEditor value={mcpEditor} open={mcpEditor !== false} onClose={() => setMcpEditor(false)} onSaved={() => { setMcpEditor(false); connections.refresh(); }} onError={setError} /></Stack>;
}

function RootEditor({ value, open, onClose, onSaved, onError }: { value: AnyRecord | null | false; open: boolean; onClose: () => void; onSaved: () => void; onError: (value: string) => void }) {
  const [form, setForm] = useState({ name: "", agent: "shared", path: "", project: "", enabled: true, followSymlinks: false, capture: false, revision: 0 });
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (value) setForm({ name: String(value.name || ""), agent: String(value.agent || "shared"), path: String(value.path || ""), project: String(value.project || ""), enabled: value.enabled !== false, followSymlinks: Boolean(value.followSymlinks), capture: Boolean(value.capture), revision: Number(value.revision || 0) }); else if (value === null) setForm({ name: "", agent: "shared", path: "", project: "", enabled: true, followSymlinks: false, capture: false, revision: 0 }); }, [value]);
  return <Modal title={value ? "Edit asset root" : "Add asset root"} open={open} onOpenChange={(next) => !next && onClose()}><form className="form-grid" onSubmit={async (event) => { event.preventDefault(); setBusy(true); try { const body = { ...form, project: form.project || null, ...(value ? { revision: form.revision } : {}) }; await send(value ? `/asset-roots/${encodeURIComponent(String(value.id))}` : "/asset-roots", value ? "PATCH" : "POST", body); onSaved(); } catch (reason) { onError(errorText(reason)); } finally { setBusy(false); } }}><Field label="Name"><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field><Field label="Agent"><select value={form.agent} onChange={(event) => setForm({ ...form, agent: event.target.value })}><option value="shared">Shared</option><option value="claude">Claude</option><option value="codex">Codex</option><option value="pi">Pi</option></select></Field><Field label="Path"><input required value={form.path} onChange={(event) => setForm({ ...form, path: event.target.value })} /></Field><Field label="Project"><input value={form.project} onChange={(event) => setForm({ ...form, project: event.target.value })} /></Field><label className="switch"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />Enabled</label><label className="switch"><input type="checkbox" checked={form.followSymlinks} onChange={(event) => setForm({ ...form, followSymlinks: event.target.checked })} />Follow symlinks</label><label className="switch"><input type="checkbox" checked={form.capture} onChange={(event) => setForm({ ...form, capture: event.target.checked })} />Capture metadata</label><div className="form-actions full"><Button variant="quiet" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} type="submit">Save</Button></div></form></Modal>;
}

function McpEditor({ value, open, onClose, onSaved, onError }: { value: AnyRecord | null | false; open: boolean; onClose: () => void; onSaved: () => void; onError: (value: string) => void }) {
  const [form, setForm] = useState({ name: "", transport: "http", url: "", command: "", args: "[]", env: "{}", headers: "{}" });
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (value) setForm({ name: String(value.name || ""), transport: String(value.transport || "http"), url: String(value.url || ""), command: String(value.command || ""), args: JSON.stringify(value.args || [], null, 2), env: "{}", headers: "{}" }); else if (value === null) setForm({ name: "", transport: "http", url: "", command: "", args: "[]", env: "{}", headers: "{}" }); }, [value]);
  return <Modal title={value ? "Edit MCP connection" : "Add MCP connection"} open={open} onOpenChange={(next) => !next && onClose()}><form className="form-grid" onSubmit={async (event) => { event.preventDefault(); setBusy(true); try { const body = { name: form.name, transport: form.transport, ...(form.transport === "http" ? { url: form.url } : { command: form.command }), args: JSON.parse(form.args), env: JSON.parse(form.env), headers: JSON.parse(form.headers) }; await send(value ? `/mcp/${encodeURIComponent(String(value.id))}` : "/mcp", value ? "PATCH" : "POST", value ? { enabled: value.enabled !== false } : body); onSaved(); } catch (reason) { onError(reason instanceof SyntaxError ? "Arguments, environment, and headers must be valid JSON." : errorText(reason)); } finally { setBusy(false); } }}><Field label="Name"><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field><Field label="Transport"><select disabled={Boolean(value)} value={form.transport} onChange={(event) => setForm({ ...form, transport: event.target.value })}><option value="http">HTTP</option><option value="stdio">stdio</option></select></Field>{form.transport === "http" ? <Field label="URL"><input required type="url" value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} /></Field> : <Field label="Command"><input required value={form.command} onChange={(event) => setForm({ ...form, command: event.target.value })} /></Field>}<Field label="Arguments JSON"><textarea className="mono full" rows={3} value={form.args} onChange={(event) => setForm({ ...form, args: event.target.value })} /></Field><Field label="Environment JSON"><textarea className="mono full" rows={3} value={form.env} onChange={(event) => setForm({ ...form, env: event.target.value })} /></Field><Field label="Headers JSON"><textarea className="mono full" rows={3} value={form.headers} onChange={(event) => setForm({ ...form, headers: event.target.value })} /></Field><div className="form-actions full"><Button variant="quiet" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} type="submit">Save</Button></div></form></Modal>;
}
