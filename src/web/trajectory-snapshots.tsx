import { useState } from "react";
import { CameraIcon, DownloadSimpleIcon, GitDiffIcon, TrashIcon } from "@phosphor-icons/react";
import { api, errorText } from "./api";
import { tr, formatDate } from "./i18n";
import { Badge, Button, Confirm, Field, Modal } from "./components";
import { AutoPage, BlockBody, SnapshotInspector, usePages } from "./trajectory";
import type { CaptureStage } from "../shared/types";
import type { ContextSnapshot, ContextSnapshotPage, TrajectoryNode, TrajectorySession, TrajectoryChange } from "../shared/trajectory";

const stageKeys = { request: "traffic.stage.request", effective: "traffic.stage.effective", upstream: "traffic.stage.upstream", response: "traffic.stage.response", output: "traffic.stage.output", node: "trajectory.snapshot.node" } as const;
function SnapshotDiff({ before, after, stage }: { before: string; after: string; stage: CaptureStage | "node" }) {
  const path = `/trajectory/snapshots/${after}/diff?against=${before}&stage=${stage}`;
  const resource = usePages<{ comparable: boolean; changes: (TrajectoryChange & { index: number; truncated: boolean })[]; total: number | null; next: number | null }>(`${path}&limit=25`, 0, "offset");
  const first = resource.pages[0];
  return <div className="trajectory-diff">{first && !first.comparable && <p role="status">{tr("trajectory.coverage.incomplete")}</p>}{first?.comparable && first.total === 0 && <p>{tr("trajectory.diff.unchanged")}</p>}{first?.total !== null && <div className="mono muted">{first?.total}</div>}
    {resource.pages.flatMap(page => page.changes).map(change => <section className={`trajectory-change ${change.action}`} key={change.path}><header><Badge>{tr(change.action === "add" ? "trajectory.diff.add" : change.action === "remove" ? "trajectory.diff.remove" : "trajectory.diff.change")}</Badge><code>{change.path}</code></header><div className="trajectory-diff-columns"><pre>{change.before as string ?? "—"}</pre><pre>{change.after as string ?? "—"}</pre></div>{change.truncated && <ExpandedDiff path={`${path}&change=${change.index}`}/>}</section>)}
    {resource.error && <div role="alert" className="form-error">{resource.error}<Button onClick={() => void resource.load()}>{tr("common.retry")}</Button></div>}<AutoPage more={resource.more} loading={resource.loading} load={resource.load}/>
  </div>;
}
function ExpandedDiff({ path }: { path: string }) {
  const [open,setOpen]=useState(false);
  return <details className="snapshot-full-diff" open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary>{tr("trajectory.snapshot.expandDiff")}</summary>{open&&<div className="trajectory-diff-columns"><BlockBody path={`${path}&side=before`}/><BlockBody path={`${path}&side=after`}/></div>}</details>;
}
function SnapshotContent({ snapshot }: { snapshot: ContextSnapshot }) {
  const [stage, setStage] = useState<CaptureStage | "node">(snapshot.nodeKind === "traffic" ? "effective" : "node"), [mode, setMode] = useState("structured");
  return <><div className="snapshot-boundary"><Badge>{tr(snapshot.coverage === "complete" ? "trajectory.coverage.complete" : "trajectory.coverage.partial")}</Badge><code>{snapshot.hash.slice(0, 16)}</code><time>{tr("trajectory.snapshot.expires")} {formatDate(snapshot.expiresAt)}</time></div><div className="workbench-tabs">{snapshot.stages.map(item => <button key={item.name} aria-pressed={stage === item.name} onClick={() => setStage(item.name)}>{tr(stageKeys[item.name])}</button>)}</div><div className="workbench-tabs"><button aria-pressed={mode === "structured"} onClick={() => setMode("structured")}>{tr("traffic.view.structured")}</button><button aria-pressed={mode === "raw"} onClick={() => setMode("raw")}>{tr("traffic.view.raw")}</button><button aria-pressed={mode === "manifest"} onClick={() => setMode("manifest")}>{tr("field.source")}</button><a className="text-button" href={`/api/trajectory/snapshots/${snapshot.id}/export?stage=${stage}`} download><DownloadSimpleIcon size={13}/>{tr("common.export")}</a></div>{mode === "structured" ? <SnapshotInspector id={snapshot.id} stage={stage}/> : <BlockBody key={`${snapshot.id}:${stage}:${mode}`} path={`/trajectory/snapshots/${snapshot.id}/inspect?stage=${stage}&format=${mode}`}/>}</>;
}
export function ContextSnapshots({ session, node, close }: { session: TrajectorySession; node?: TrajectoryNode; close: () => void }) {
  const [revision, setRevision] = useState(0), [label, setLabel] = useState(""), [days, setDays] = useState(7), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [selected, setSelected] = useState<ContextSnapshot>(), [before, setBefore] = useState<ContextSnapshot>(), [after, setAfter] = useState<ContextSnapshot>(), [comparing, setComparing] = useState(false), [diffStage, setDiffStage] = useState<CaptureStage | "node">("effective");
  const resource = usePages<ContextSnapshotPage>(`/trajectory/snapshots?key=${encodeURIComponent(session.key)}&limit=20&refresh=${revision}`, 0, "offset");
  const snapshots = resource.pages.flatMap(page => page.items);
  const save = async () => {
    if (!node) return;
    setBusy(true); setError("");
    try {
      const saved = await api<ContextSnapshot>("/trajectory/snapshots", { method: "POST", body: JSON.stringify({ key: session.key, kind: node.source.kind, nodeId: node.source.id, label: label || node.title, retentionDays: days, confirmed: true }) });
      setRevision(value => value + 1); setSelected(saved);
    } catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  };
  const comparedStages = before && after ? before.stages.filter(item => after.stages.some(other => other.name === item.name)).map(item => item.name) : [];
  return <Modal title={tr("trajectory.snapshot.title")} wide open onOpenChange={close}>
    {(selected || comparing) && <div className="snapshot-back"><Button onClick={() => { setSelected(undefined); setComparing(false); }}>{tr("trajectory.snapshot.back")}</Button><span>{selected?.label}</span></div>}
    {selected ? <SnapshotContent key={selected.id} snapshot={selected}/> : comparing && before && after ? <><div className="snapshot-compare-heading"><span>A · {before.label}<small>{formatDate(before.createdAt)}</small></span><GitDiffIcon size={22}/><span>B · {after.label}<small>{formatDate(after.createdAt)}</small></span></div><div className="workbench-tabs">{comparedStages.map(stage => <button key={stage} aria-pressed={stage === diffStage} onClick={() => setDiffStage(stage)}>{tr(stageKeys[stage])}</button>)}</div><SnapshotDiff key={`${before.id}:${after.id}:${diffStage}`} before={before.id} after={after.id} stage={diffStage}/></> : <>
      {node ? <div className="snapshot-save"><div><CameraIcon size={19}/><strong>{node.title}</strong><Badge>{node.source.kind}</Badge></div><p>{tr("trajectory.snapshot.notice")}</p><div className="form-grid"><Field label={tr("field.name")}><input value={label} placeholder={node.title} onChange={event => setLabel(event.target.value)} maxLength={160}/></Field><Field label={tr("trajectory.snapshot.retention")}><input type="number" min={1} max={365} value={days} onChange={event => setDays(Number(event.target.value))}/></Field></div><Button className="primary" busy={busy} disabled={!Number.isInteger(days) || days < 1 || days > 365 || node.status === "running"} onClick={() => void save()}>{tr("trajectory.snapshot.save")}</Button></div> : <p className="muted">{tr("trajectory.snapshot.selectNode")}</p>}
      {(error || resource.error) && <div className="form-error" role="alert">{error || resource.error}<Button onClick={() => { setError(""); setRevision(value => value + 1); }}>{tr("common.retry")}</Button></div>}
      <div className="snapshot-selection"><span>A · {before?.label || "—"}</span><span>B · {after?.label || "—"}</span><Button disabled={!before || !after || !comparedStages.length} onClick={() => { setDiffStage(comparedStages.includes("effective") ? "effective" : comparedStages[0]); setComparing(true); }}>{tr("observability.action.diff")}</Button></div>
      {snapshots.map(snapshot => <div className="context-snapshot-row" key={snapshot.id}><button onClick={() => setSelected(snapshot)}><strong>{snapshot.label}</strong><span className="mono">{formatDate(snapshot.createdAt)} · {snapshot.bytes.toLocaleString()} B</span><small>{snapshot.nodeKind} · {snapshot.nodeId.slice(0, 8)}</small></button><div><button className="snapshot-pick" aria-label={tr("trajectory.snapshot.pickA", { name: snapshot.label })} aria-pressed={before?.id === snapshot.id} onClick={() => setBefore(snapshot)}>A</button><button className="snapshot-pick" aria-label={tr("trajectory.snapshot.pickB", { name: snapshot.label })} aria-pressed={after?.id === snapshot.id} onClick={() => setAfter(snapshot)}>B</button><Confirm title={tr("trajectory.snapshot.delete")} onConfirm={async () => { await api(`/trajectory/snapshots/${snapshot.id}`, { method: "DELETE" }); if (before?.id === snapshot.id) setBefore(undefined); if (after?.id === snapshot.id) setAfter(undefined); setRevision(value => value + 1); }}><button className="icon-button danger-icon" aria-label={tr("trajectory.snapshot.delete")}><TrashIcon size={15}/></button></Confirm></div></div>)}<AutoPage more={resource.more} loading={resource.loading} load={resource.load}/>
    </>}
  </Modal>;
}
