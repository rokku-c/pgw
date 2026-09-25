import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  ArrowDown,
  ArrowUp,
  Check,
  DownloadSimple,
  Eye,
  FileText,
  Lightning,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Play,
  Star,
  Trash,
  TreeStructure,
  TextT,
  X,
} from "@phosphor-icons/react";
import { get, send } from "./api";
import {
  Button,
  Confirm,
  ContentBlock,
  DataTable,
  DetailHeader,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  Modal,
  PageHeader,
  Panel,
  Section,
  Stack,
  StatusBadge,
  Timeline,
  Toolbar,
  type RecordValue,
} from "./components";

type AnyRecord = Record<string, any>;

function useFetch<T>(path: string, deps: unknown[] = []) {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!path) {
      setData(undefined);
      setLoading(false);
      setError("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    void get<T>(path)
      .then((value) => { if (!cancelled) setData(value); })
      .catch((reason) => { if (!cancelled) setError(errorText(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path, version, ...deps]);
  return { data, loading, error, refresh: () => setVersion((value) => value + 1) };
}

function useJobFetch<T>(path: string, deps: unknown[] = []) {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!path) {
      setData(undefined);
      setLoading(false);
      setError("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    void get<AnyRecord>(path)
      .then((value) => (value?.job ? pollJob(value) : value))
      .then((value) => { if (!cancelled) setData(value as T); })
      .catch((reason) => { if (!cancelled) setError(errorText(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path, version, ...deps]);
  return { data, loading, error, refresh: () => setVersion((value) => value + 1) };
}

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

function errorText(reason: unknown) { return reason instanceof Error ? reason.message : "Request failed"; }
function date(value: unknown) { const number = Number(value); return Number.isFinite(number) && number > 0 ? new Date(number).toLocaleString() : "—"; }
function money(value: unknown) { const number = Number(value); return Number.isFinite(number) && number > 0 ? `$${(number / 1_000_000).toFixed(4)}` : "—"; }
function tone(value: unknown) { const text = String(value ?? "unknown"); const positive = ["completed", "running", "active", "up", "indexed", "accepted"]; const negative = ["failed", "error", "cancelled", "down", "declined"]; return <StatusBadge tone={positive.includes(text) ? "success" : negative.includes(text) ? "danger" : "warning"}>{text}</StatusBadge>; }
function itemsFrom(value: AnyRecord | undefined) { return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : []; }
function preview(value: unknown) { const text = typeof value === "string" ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })(); return text.replace(/\s+/g, " ").trim().slice(0, 180) || "Empty event"; }
const trafficStages = [{ id: "request", label: "Request", icon: FileText }, { id: "effective", label: "Effective", icon: Lightning }, { id: "upstream", label: "Upstream", icon: ArrowUp }, { id: "response", label: "Response", icon: ArrowDown }, { id: "output", label: "Output", icon: TextT }];

export function TrafficPage() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<AnyRecord>();
  const path = `/traffic?limit=40&offset=${offset}${query ? `&query=${encodeURIComponent(query)}` : ""}${status ? `&status=${status}` : ""}`;
  const result = useFetch<AnyRecord>(path, [query, status, offset]);
  return <Stack className="screen-page">
    <PageHeader icon={TreeStructure} title="Traffic" description="Read requests as a sequence of stages, attempts, and related session calls." actions={<Toolbar><Button onClick={result.refresh}><ArrowClockwise size={15} />Refresh</Button></Toolbar>} />
    <div className={`workspace-split workspace-traffic-split ${selected ? "has-detail" : ""}`}>
      <section className="workspace-pane workspace-list-pane"><div className="workspace-pane-header"><div><span className="eyebrow">REQUESTS</span><strong>{result.data?.total ?? 0} captured requests</strong></div><span className="muted">{selected ? "Request selected" : "Select a row to inspect"}</span></div><div className="workspace-pane-tools"><label className="search-box"><MagnifyingGlass size={15} /><input value={query} onChange={(event) => { setOffset(0); setQuery(event.target.value); }} placeholder="Model, client, provider" /></label><select value={status} onChange={(event) => { setOffset(0); setStatus(event.target.value); }}><option value="">All statuses</option><option value="running">Running</option><option value="completed">Completed</option><option value="failed">Failed</option><option value="cancelled">Cancelled</option></select></div><div className="workspace-table">{result.error ? <ErrorBox error={result.error} /> : result.loading ? <Loading /> : <DataTable rows={itemsFrom(result.data)} empty="No requests match the filter" onRowClick={setSelected} activeRowId={selected?.id} columns={[{ key: "model", label: "Model" }, { key: "clientName", label: "Client" }, { key: "status", label: "Status", render: (row) => tone(row.status) }, { key: "latencyMs", label: "Latency", render: (row) => `${row.latencyMs ?? "—"} ms` }, { key: "costMicros", label: "Cost", render: (row) => money(row.costMicros) }, { key: "createdAt", label: "Created", render: (row) => date(row.createdAt) }]} />}</div><div className="pager"><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 40))}><ArrowLeft size={14} />Previous</Button><Button disabled={!result.data?.next} onClick={() => setOffset(result.data?.next || offset + 40)}>Next<ArrowRight size={14} /></Button></div></section>
      {selected ? <section className="workspace-pane workspace-detail-pane"><TrafficDetail id={selected.id} embedded onClose={() => setSelected(undefined)} onChanged={result.refresh} /></section> : null}
    </div>
  </Stack>;
}

function TrafficDetail({ id, embedded = false, onClose, onChanged }: { id?: string; embedded?: boolean; onClose: () => void; onChanged: () => void }) {
  const detail = useFetch<AnyRecord>(id ? `/traffic/${encodeURIComponent(String(id))}` : "", [id]);
  const [stage, setStage] = useState("request");
  const capture = useFetch<unknown>(id ? `/traffic/${encodeURIComponent(String(id))}/capture/${stage}` : "", [id, stage]);
  const request = detail.data?.request;
  const attempts = Array.isArray(detail.data?.attempts) ? detail.data.attempts : [];
  const sessionRequests = detail.data?.sessionRequests || [];
  return <div className={`detail-screen ${embedded ? "embedded-detail" : ""}`}><DetailHeader eyebrow="REQUEST" title={String(request?.model || request?.id || "Request detail")} onBack={onClose} description={request ? <span className="mono break-anywhere">{String(request.id || "")}</span> : null} actions={request ? <Confirm title="Delete captured content" onConfirm={async () => { await send(`/traffic/${encodeURIComponent(String(id))}/capture`, "DELETE"); onChanged(); }}><Button variant="danger"><Trash size={14} />Delete capture</Button></Confirm> : null} /><div className="detail-screen-body">{detail.loading ? <Loading /> : detail.error ? <ErrorBox error={detail.error} /> : !request ? <EmptyState title="Request not found" /> : <Stack className="reading-flow">
    <Section title="Summary"><div className="detail-list"><div><span>Status</span><strong>{tone(request.status)}</strong></div><div><span>Latency</span><strong>{request.latencyMs ?? "—"} ms</strong></div><div><span>Cost</span><strong>{money(request.costMicros)}</strong></div><div><span>Provider</span><strong>{String(request.providerName || "—")}</strong></div><div><span>Client</span><strong>{String(request.clientName || "—")}</strong></div></div></Section>
    <Section title="Captured content"><div className="tabs">{trafficStages.map(({ id, label, icon: IconComponent }) => <button type="button" key={id} className={stage === id ? "active" : ""} onClick={() => setStage(id)}><IconComponent size={14} />{label}</button>)}</div>{capture.loading ? <Loading label={`Loading ${stage}`} /> : capture.error ? <EmptyState title={`No ${stage} capture`} /> : <ContentBlock value={capture.data} title={`${stage} stage`} />}</Section>
    <Section title="Headers"><ContentBlock value={request.requestHeaders || request.responseHeaders || {}} /></Section>
    <Section title="Attempts"><DataTable rows={attempts} empty="No attempts recorded" columns={[{ key: "status", label: "Status", render: (row) => tone(row.status) }, { key: "upstreamStatus", label: "HTTP" }, { key: "latencyMs", label: "Latency", render: (row) => `${row.latencyMs ?? "—"} ms` }, { key: "error", label: "Error" }]} /></Section>
    <Section title="Routing and session requests"><ContentBlock value={sessionRequests} title="Related requests" /></Section>
  </Stack>}</div></div>;
}

export function CompleteSessionsPage() {
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [searchVersion, setSearchVersion] = useState(0);
  const [selected, setSelected] = useState<AnyRecord>();
  const [error, setError] = useState("");
  const [sources, setSources] = useState<AnyRecord[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourceEditor, setSourceEditor] = useState<AnyRecord | null | false>(false);
  const [sourceVersion, setSourceVersion] = useState(0);
  const sessions = useJobFetch<AnyRecord>(`/sessions?paged=true&limit=40&offset=${offset}${query ? `&query=${encodeURIComponent(query)}` : ""}`, [offset, searchVersion]);
  useEffect(() => { setSourcesLoading(true); void get<AnyRecord[]>("/sources").then(setSources).catch((reason) => setError(errorText(reason))).finally(() => setSourcesLoading(false)); }, [sourceVersion]);
  const refresh = () => { setSourceVersion((value) => value + 1); sessions.refresh(); };
  if (selected) return <SessionDetail value={selected} error={error} onClose={() => setSelected(undefined)} onChanged={refresh} onError={setError} />;
  return <Stack className="screen-page sessions-screen">
    <PageHeader icon={TreeStructure} title="Sessions" description="Search, read, tag, star, export, and forget indexed sessions." actions={<Toolbar><Button onClick={refresh}><ArrowClockwise size={15} />Refresh</Button><Button variant="primary" onClick={async () => { try { await Promise.all(sources.map(async (source) => pollJob(await send(`/sources/${source.id}/scan`, "POST")))); refresh(); } catch (reason) { setError(errorText(reason)); } }}><Play size={15} />Scan all</Button></Toolbar>} />
    <ErrorBox error={error || sessions.error} />
    <div className="sessions-layout">
      <section className="workspace-pane sources-pane"><div className="workspace-pane-header"><div><span className="eyebrow">COLLECTION SOURCES</span><strong>{sources.length} configured sources</strong></div><Button variant="primary" onClick={() => setSourceEditor(null)}><Plus size={14} />Add source</Button></div><div className="workspace-table">{sourcesLoading ? <Loading /> : <DataTable rows={sources} empty="No collection sources" columns={[{ key: "name", label: "Name" }, { key: "agent", label: "Agent" }, { key: "path", label: "Path" }, { key: "state", label: "State", render: (row) => tone(row.state) }, { key: "actions", label: "Actions", render: (row) => <Toolbar><Button onClick={() => setSourceEditor(row)}><PencilSimple size={14} />Edit</Button><Button onClick={async () => { try { await pollJob(await send(`/sources/${row.id}/scan`, "POST")); refresh(); } catch (reason) { setError(errorText(reason)); } }}><Play size={14} />Scan</Button><Confirm title="Remove source" onConfirm={async () => { await send(`/sources/${row.id}`, "DELETE"); refresh(); }}><Button variant="danger"><Trash size={14} />Remove</Button></Confirm></Toolbar> }]} />}</div></section>
      <section className="workspace-pane session-index-pane"><div className="workspace-pane-header"><div><span className="eyebrow">SESSION INDEX</span><strong>{sessions.data?.total ?? 0} indexed sessions</strong></div><span className="muted">Select a row to inspect</span></div><div className="workspace-pane-tools"><label className="search-box"><MagnifyingGlass size={15} /><input value={query} onChange={(event) => { setOffset(0); setQuery(event.target.value); }} placeholder="Search title, project, content" /></label><Button onClick={() => setSearchVersion((value) => value + 1)}>Search</Button></div><div className="workspace-table">{sessions.loading ? <Loading /> : <DataTable rows={itemsFrom(sessions.data)} empty="No sessions" onRowClick={setSelected} columns={[{ key: "title", label: "Title" }, { key: "agent", label: "Agent" }, { key: "project", label: "Project" }, { key: "status", label: "Status", render: (row) => tone(row.status) }, { key: "lastActiveAt", label: "Last active", render: (row) => date(row.lastActiveAt) }, { key: "starred", label: "", render: (row) => row.starred ? <Star size={14} weight="fill" /> : null }]} />}</div><div className="pager"><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 40))}>Previous</Button><Button disabled={!sessions.data?.next} onClick={() => setOffset(sessions.data?.next || offset + 40)}>Next</Button></div></section>
    </div>
    <SourceForm value={sourceEditor} open={sourceEditor !== false} onClose={() => setSourceEditor(false)} onSaved={() => { setSourceEditor(false); refresh(); }} onError={setError} />
  </Stack>;
}

function SourceForm({ value, open, onClose, onSaved, onError }: { value: AnyRecord | null | false; open: boolean; onClose: () => void; onSaved: () => void; onError: (value: string) => void }) {
  const [form, setForm] = useState({ name: "", agent: "auto", path: "", enabled: true, captureBodies: false, learn: true });
  const [busy, setBusy] = useState(false);
  const existing = value === null || value === false ? undefined : value;
  useEffect(() => { setForm({ name: String(existing?.name || ""), agent: String(existing?.agent || "auto"), path: String(existing?.path || ""), enabled: existing?.enabled !== false, captureBodies: Boolean(existing?.captureBodies), learn: existing?.learn !== false }); }, [existing]);
  return <Modal title={existing ? "Edit source" : "Add source"} open={open} onOpenChange={(next) => !next && onClose()}><form className="form-grid" onSubmit={async (event) => { event.preventDefault(); setBusy(true); try { await send(existing ? `/sources/${existing.id}` : "/sources", existing ? "PATCH" : "POST", { ...form, ...(existing?.revision ? { revision: existing.revision } : {}) }); onSaved(); } catch (reason) { onError(errorText(reason)); } finally { setBusy(false); } }}><Field label="Name"><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field><Field label="Agent"><select value={form.agent} onChange={(event) => setForm({ ...form, agent: event.target.value })}><option value="auto">Auto</option><option value="claude">Claude</option><option value="codex">Codex</option><option value="pi">Pi</option></select></Field><Field label="Path"><input required value={form.path} onChange={(event) => setForm({ ...form, path: event.target.value })} placeholder="/absolute/path" /></Field><label className="switch"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />Enabled</label><label className="switch"><input type="checkbox" checked={form.captureBodies} onChange={(event) => setForm({ ...form, captureBodies: event.target.checked })} />Capture bodies</label><label className="switch"><input type="checkbox" checked={form.learn} onChange={(event) => setForm({ ...form, learn: event.target.checked })} />Learn preferences</label><div className="form-actions"><Button variant="quiet" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} type="submit">Save</Button></div></form></Modal>;
}

function SessionDetail({ value, error, onClose, onChanged, onError }: { value?: AnyRecord; error?: string; onClose: () => void; onChanged: () => void; onError: (value: string) => void }) {
  const detail = useFetch<AnyRecord>(value ? `/sessions/${encodeURIComponent(String(value.id))}?limit=200&order=asc` : "", [value]);
  const session = detail.data?.session || value;
  const [tags, setTags] = useState("");
  useEffect(() => { setTags(Array.isArray(session?.tags) ? session.tags.join(", ") : ""); }, [session]);
  const update = async (body: AnyRecord) => { try { await send(`/sessions/${encodeURIComponent(String(session.id))}`, "PATCH", body); onChanged(); } catch (reason) { onError(errorText(reason)); } };
  return <div className="detail-screen"><DetailHeader eyebrow="SESSION" title={String(session?.title || session?.id || "Session detail")} onBack={onClose} description={session ? `${String(session.agent || "Unknown agent")} · ${String(session.project || "Local project")}` : null} actions={session ? <Toolbar><Button onClick={() => update({ starred: !session.starred })}><Star size={14} weight={session.starred ? "fill" : "regular"} />{session.starred ? "Unstar" : "Star"}</Button><a className="button" href={`/api/sessions/${encodeURIComponent(String(session.id))}/export?limit=200`} download><DownloadSimple size={14} />Export</a><Confirm title="Forget session" onConfirm={async () => { await send(`/sessions/${encodeURIComponent(String(session.id))}`, "DELETE"); onChanged(); onClose(); }}><Button variant="danger"><Trash size={14} />Forget</Button></Confirm></Toolbar> : null} /><div className="detail-screen-body"><ErrorBox error={error} />{detail.loading ? <Loading /> : detail.error ? <ErrorBox error={detail.error} /> : !session ? <EmptyState title="Session unavailable" /> : <Stack className="reading-flow">
    <Section title="Session summary"><div className="detail-list"><div><span>Status</span><strong>{tone(session.status)}</strong></div><div><span>Messages</span><strong>{String(session.messageCount ?? detail.data?.events?.length ?? 0)}</strong></div><div><span>Last active</span><strong>{date(session.lastActiveAt)}</strong></div></div></Section>
    <Section title="Tags"><div className="tag-editor"><Field label="Tags"><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="comma,separated,tags" /></Field><Button onClick={() => update({ tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean) })}><Check size={14} />Save tags</Button></div></Section>
    <Section title="Timeline"><Timeline items={(detail.data?.events || []) as RecordValue[]} render={(event) => { const body = event.text || event.content || event.message || event.detail || event; return <><div className="timeline-meta"><strong>{String(event.role || event.kind || "Event")}</strong><span>{date(event.timestamp || event.createdAt)}</span></div><details className="timeline-event"><summary><span>{preview(body)}</span><span className="timeline-event-action">View event</span></summary><ContentBlock value={body} /></details></>; }} /></Section>
  </Stack>}</div></div>;
}

export function CompleteObservabilityPage() {
  const [query, setQuery] = useState("");
  const [selectedSession, setSelectedSession] = useState<AnyRecord>();
  const [selectedNode, setSelectedNode] = useState<AnyRecord>();
  const [selectedSnapshot, setSelectedSnapshot] = useState<AnyRecord>();
  const [againstSnapshot, setAgainstSnapshot] = useState("");
  const [error, setError] = useState("");
  const sessions = useFetch<AnyRecord>(`/trajectory/sessions?limit=40${query ? `&query=${encodeURIComponent(query)}` : ""}`, [query]);
  const nodes = useFetch<AnyRecord>(selectedSession ? `/trajectory/sessions/${encodeURIComponent(String(selectedSession.key))}/nodes?limit=100` : "", [selectedSession]);
  const snapshots = useFetch<AnyRecord>(selectedSession ? `/trajectory/snapshots?key=${encodeURIComponent(String(selectedSession.key))}&limit=30` : "", [selectedSession]);
  return <Stack className="screen-page">
    <PageHeader icon={Eye} title="Observe" description="Follow a trajectory from session to node evidence without losing context." actions={<Toolbar><Button onClick={sessions.refresh}><ArrowClockwise size={15} />Refresh</Button></Toolbar>} />
    <div className={`workspace-split workspace-observe-split ${selectedSession ? "has-detail" : ""}`}>
      <section className="workspace-pane workspace-list-pane"><div className="workspace-pane-header"><div><span className="eyebrow">TRAJECTORY SESSIONS</span><strong>{itemsFrom(sessions.data).length} indexed sessions</strong></div><span className="muted">{selectedSession ? "Session selected" : "Select a session to inspect"}</span></div><div className="workspace-pane-tools"><label className="search-box"><MagnifyingGlass size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search session, agent, project" /></label></div><div className="workspace-table">{sessions.loading ? <Loading /> : sessions.error ? <ErrorBox error={sessions.error} /> : <DataTable rows={itemsFrom(sessions.data)} empty="No trajectory sessions" onRowClick={setSelectedSession} activeRowId={selectedSession?.key || selectedSession?.id} columns={[{ key: "title", label: "Session" }, { key: "kind", label: "Kind" }, { key: "agent", label: "Agent" }, { key: "calls", label: "Calls" }, { key: "events", label: "Events" }, { key: "status", label: "Status", render: (row) => tone(row.status) }, { key: "at", label: "Updated", render: (row) => date(row.at) }]} />}</div></section>
      {selectedSession ? <section className="workspace-pane workspace-detail-pane"><TrajectorySessionDetail embedded session={selectedSession} nodes={nodes} snapshots={snapshots} onClose={() => { setSelectedNode(undefined); setSelectedSnapshot(undefined); setSelectedSession(undefined); }} onNode={setSelectedNode} onSnapshot={(row) => { setSelectedSnapshot(row); setAgainstSnapshot(""); }} /></section> : null}
    </div>
    <TrajectoryNodeDetail session={selectedSession} value={selectedNode} onClose={() => setSelectedNode(undefined)} onError={setError} />
    <SnapshotDetail value={selectedSnapshot} snapshots={itemsFrom(snapshots.data)} against={againstSnapshot} setAgainst={setAgainstSnapshot} onClose={() => setSelectedSnapshot(undefined)} onError={setError} />
    <ErrorBox error={error} />
  </Stack>;
}

function TrajectorySessionDetail({ session, embedded = false, nodes, snapshots, onClose, onNode, onSnapshot }: { session?: AnyRecord; embedded?: boolean; nodes: { data?: AnyRecord; loading: boolean; error: string }; snapshots: { data?: AnyRecord; loading: boolean; error: string }; onClose: () => void; onNode: (value: AnyRecord) => void; onSnapshot: (value: AnyRecord) => void }) {
  if (!session) return null;
  return <div className={`detail-screen ${embedded ? "embedded-detail" : ""}`}><DetailHeader eyebrow="TRAJECTORY SESSION" title={String(session.title || session.key)} onBack={onClose} description={<span className="mono break-anywhere">{String(session.key)}</span>} /><div className="detail-screen-body"><Stack className="reading-flow"><Section title="Nodes" actions={<span className="muted">{itemsFrom(nodes.data).length} nodes</span>}>{nodes.loading ? <Loading /> : nodes.error ? <ErrorBox error={nodes.error} /> : <DataTable rows={itemsFrom(nodes.data)} empty="No nodes in this session" onRowClick={onNode} columns={[{ key: "title", label: "Node" }, { key: "kind", label: "Kind" }, { key: "status", label: "Status", render: (row) => tone(row.status) }, { key: "at", label: "Time", render: (row) => date(row.at) }, { key: "evidence", label: "Evidence", render: (row) => <span className="break-anywhere">{String((row.evidence as AnyRecord | undefined)?.source || (row.source as AnyRecord | undefined)?.kind || "—")}</span> }]} />}</Section><Section title="Snapshots" actions={<span className="muted">{itemsFrom(snapshots.data).length} saved</span>}>{snapshots.loading ? <Loading /> : snapshots.error ? <ErrorBox error={snapshots.error} /> : <DataTable rows={itemsFrom(snapshots.data)} empty="No snapshots for this session" onRowClick={onSnapshot} columns={[{ key: "label", label: "Label" }, { key: "hash", label: "Hash" }, { key: "createdAt", label: "Created", render: (row) => date(row.createdAt) }, { key: "summary", label: "Summary", render: (row) => <ContentBlock value={row.summary} allowRaw={false} /> }]} />}</Section></Stack></div></div>;
}

function SnapshotDetail({ value, snapshots, against, setAgainst, onClose, onError }: { value?: AnyRecord; snapshots: AnyRecord[]; against: string; setAgainst: (value: string) => void; onClose: () => void; onError: (value: string) => void }) {
  const inspect = useFetch<AnyRecord>(value ? `/trajectory/snapshots/${encodeURIComponent(String(value.id))}/inspect?format=structured` : "", [value]);
  const diff = useFetch<AnyRecord>(value && against ? `/trajectory/snapshots/${encodeURIComponent(String(value.id))}/diff?against=${encodeURIComponent(against)}&format=structured` : "", [value, against]);
  return <Modal title={value?.label || "Snapshot detail"} open={Boolean(value)} onOpenChange={(open) => !open && onClose()} wide>{!value ? null : <Stack className="reading-flow"><DetailHeader eyebrow="SNAPSHOT" title={String(value.label || value.id)} onBack={onClose} actions={<a className="button" href={`/api/trajectory/snapshots/${encodeURIComponent(String(value.id))}/export`} download><DownloadSimple size={14} />Export</a>} /><Section title="Inspect">{inspect.loading ? <Loading /> : inspect.error ? <ErrorBox error={inspect.error} /> : <ContentBlock value={inspect.data} />}</Section><Section title="Compare"><Field label="Compare against"><select value={against} onChange={(event) => setAgainst(event.target.value)}><option value="">Select another snapshot</option>{snapshots.filter((snapshot) => snapshot.id !== value.id).map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{snapshot.label || snapshot.id}</option>)}</select></Field>{against ? diff.loading ? <Loading /> : diff.error ? <ErrorBox error={diff.error} /> : <ContentBlock value={diff.data} title="Diff" /> : <EmptyState title="Choose a snapshot to compare" />}</Section></Stack>}</Modal>;
}

function TrajectoryNodeDetail({ session, value, onClose, onError }: { session?: AnyRecord; value?: AnyRecord; onClose: () => void; onError: (value: string) => void }) {
  const [detail, setDetail] = useState<AnyRecord>();
  const [loading, setLoading] = useState(false);
  useEffect(() => { if (!session || !value) return; setLoading(true); void get<AnyRecord>(`/trajectory/sessions/${encodeURIComponent(String(session.key))}/node?kind=${encodeURIComponent(String(value.source?.kind || value.kind || "traffic"))}&id=${encodeURIComponent(String(value.source?.id || value.id))}`).then(setDetail).catch((reason) => onError(errorText(reason))).finally(() => setLoading(false)); }, [session, value]);
  const body = detail?.text ?? detail;
  const source = value?.source as AnyRecord | undefined;
  const callId = source?.kind === "traffic" ? source.id : undefined;
  const inspect = useFetch<AnyRecord>(callId ? `/trajectory/calls/${encodeURIComponent(String(callId))}/inspect?stage=effective` : "", [callId]);
  const diff = useFetch<AnyRecord>(callId ? `/trajectory/calls/${encodeURIComponent(String(callId))}/diff?beforeStage=request&afterStage=effective` : "", [callId]);
  return <Modal title={value?.title || "Node detail"} open={Boolean(value)} onOpenChange={(open) => !open && onClose()} wide>{loading ? <Loading /> : !detail ? <EmptyState title="Node unavailable" /> : <Stack className="reading-flow"><DetailHeader eyebrow={String(value?.kind || "NODE")} title={String(value?.title || value?.id || "Node")} onBack={onClose} /><Section title="Evidence"><ContentBlock value={value?.evidence || value?.source || {}} /></Section><Section title="Metadata"><ContentBlock value={{ id: value?.id, kind: value?.kind, status: value?.status, at: value?.at, relations: value?.relations }} /></Section><Section title="Body"><ContentBlock value={body} /></Section>{callId ? <><Section title="Call inspect">{inspect.loading ? <Loading /> : inspect.error ? <ErrorBox error={inspect.error} /> : <ContentBlock value={inspect.data} />}</Section><Section title="Call diff">{diff.loading ? <Loading /> : diff.error ? <ErrorBox error={diff.error} /> : <ContentBlock value={diff.data} />}</Section></> : null}</Stack>}</Modal>;
}

export const SessionsPage = CompleteSessionsPage;
export const ObservabilityPage = CompleteObservabilityPage;
