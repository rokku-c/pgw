import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText } from "./api";
import { tr } from "./i18n";
import { Badge, Button } from "./components";
import type { CaptureStage } from "../shared/types";
import type { TrajectoryWindow } from "../shared/trajectory";

const sections = { system: "trajectory.section.system", messages: "trajectory.section.messages", tools: "trajectory.section.tools", config: "trajectory.section.config", transport: "trajectory.section.transport", output: "trajectory.section.output", other: "trajectory.section.other" } as const;
const states = { complete: "trajectory.coverage.complete", recording: "trajectory.coverage.recording", partial: "trajectory.coverage.partial", not_captured: "traffic.capture.none", expired: "trajectory.coverage.expired", deleted: "trajectory.coverage.deleted" } as const;

export function AutoPage({ more, loading, load }: { more: boolean; loading: boolean; load: () => void }) {
  const target = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = target.current;
    if (!node || !more || loading) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) load(); }, { root: node.closest(".trajectory-scroll") || node.closest(".modal"), rootMargin: "150px" });
    observer.observe(node); return () => observer.disconnect();
  }, [more, loading, load]);
  return <div ref={target} className="trajectory-load" role="status">{loading ? tr("common.loading") : null}</div>;
}
export function usePages<T extends { next: number | string | null; revision?: string }>(path: string, initial: number | string, key: string) {
  const [pages, setPages] = useState<T[]>([]), [error, setError] = useState<string>(), [loading, setLoading] = useState(false);
  const pinned = useRef<string | null>(null);
  const cursor = useRef<number | string | null>(initial), pending = useRef(false), controller = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    if (pending.current || cursor.current === null || !controller.current || controller.current.signal.aborted) return;
    pending.current = true; setLoading(true); setError(undefined);
    const signal = controller.current.signal;
    try {
      const page = await api<T>(`${path}&${key}=${encodeURIComponent(String(cursor.current))}${pinned.current ? `&revision=${encodeURIComponent(pinned.current)}` : ""}`, { signal });
      if (signal.aborted) return;
      if (page.next === cursor.current) throw new Error("trajectory_cursor_stalled");
      if(page.revision)pinned.current=page.revision;
      setPages(previous => [...previous, page]); cursor.current = page.next;
    } catch (error) { if (!signal.aborted) setError(errorText(error)); }
    finally { if (!signal.aborted) { pending.current = false; setLoading(false); } }
  }, [path, key]);
  useEffect(() => {
    const current = new AbortController(); controller.current = current; cursor.current = initial; pinned.current = null; pending.current = false; setPages([]); setError(undefined);
    void load(); return () => current.abort();
  }, [load, initial]);
  return { pages, error, loading, load, more: !error && cursor.current !== null };
}
export function BlockBody({ path }: { path: string }) {
  const resource = usePages<{ text: string; next: number | null }>(path, 0, "start");
  return <><div className="trajectory-text-pages">{resource.pages.map((page, index) => <pre key={index}>{page.text}</pre>)}</div>{resource.error && <div role="alert">{resource.error}<Button onClick={() => void resource.load()}>{tr("common.retry")}</Button></div>}<AutoPage more={resource.more} loading={resource.loading} load={resource.load}/></>;
}
function Block({ block, path }: { block: TrajectoryWindow["blocks"][number]; path: string }) {
  const [open, setOpen] = useState(false);
  return <details className="trajectory-block" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><div className="trajectory-block-heading"><Badge>{block.role || block.kind}</Badge><strong>{block.name || block.callId || block.id}</strong><span className="mono muted">{block.length.toLocaleString()}</span></div>{!open && <span className="trajectory-preview">{block.preview.slice(0, 240)}{block.length > 240 ? "…" : ""}</span>}</summary>
    {open && (block.truncated ? <BlockBody key={block.id} path={`${path}&block=${encodeURIComponent(block.id)}`}/> : <pre className="trajectory-value">{block.preview}</pre>)}
  </details>;
}
function InspectorWindow({ id, stage, endpoint }: { id: string; stage: CaptureStage | "node"; endpoint?: string }) {
  const [section, setSection] = useState<string>("");
  const base = endpoint || `/trajectory/calls/${id}/inspect?stage=${stage}`;
  const resource = usePages<TrajectoryWindow>(`${base}&limit=25${section ? `&section=${section}` : ""}`, 0, "offset");
  const first = resource.pages[0];
  return <div className="trajectory-inspector">
    {first && <><div className="trajectory-coverage"><Badge>{tr(states[first.coverage])}</Badge><span className="mono">{first.format} · {first.total}</span>{(first.reason || first.warnings.length > 0) && <span>{tr("trajectory.coverage.incomplete")}</span>}</div><div className="trajectory-section-tabs"><button aria-pressed={!section} onClick={() => setSection("")}>{tr("common.all")}</button>{first.sections.map(item => <button key={item.name} aria-pressed={section === item.name} onClick={() => setSection(item.name)}>{tr(sections[item.name])}<span>{item.count}</span></button>)}</div></>}
    {resource.pages.flatMap(page => page.blocks).map(block => <Block key={block.id} block={block} path={base}/>)}
    {resource.error && <div role="alert" className="form-error">{resource.error}<Button onClick={() => void resource.load()}>{tr("common.retry")}</Button></div>}
    {first && first.total === 0 && <div className="trajectory-load">{tr("traffic.capture.empty")}</div>}
    <AutoPage more={resource.more} loading={resource.loading} load={resource.load}/>
  </div>;
}
export function TrajectoryInspector({ id, stage }: { id: string; stage: CaptureStage }) { return <InspectorWindow key={`${id}:${stage}`} id={id} stage={stage}/>; }

export function TrajectoryRaw({ id, stage }: { id: string; stage: CaptureStage }) {
  return <RawWindow key={`${id}:${stage}`} id={id} stage={stage}/>;
}
function RawWindow({ id, stage }: { id: string; stage: CaptureStage }) {
  const resource = usePages<import("../shared/types").CapturePage>(`/traffic/${id}/capture/${stage}?limit=2`, -1, "after");
  return <><div className="trajectory-text-pages">{resource.pages.map((page, index) => <pre key={index}>{page.text}</pre>)}</div>{resource.error && <div role="alert" className="form-error">{resource.error}<Button onClick={() => void resource.load()}>{tr("common.retry")}</Button></div>}<AutoPage more={resource.more} loading={resource.loading} load={resource.load}/></>;
}
export function TrajectoryDiff({ before, after }: { before: string; after: string }) {
  return <DiffWindow key={`${before}:${after}`} before={before} after={after}/>;
}
function DiffWindow({ before, after }: { before: string; after: string }) {
  const resource = usePages<{ comparable: boolean; changes: (import("../shared/trajectory").TrajectoryChange & { truncated: boolean })[]; next: number | null; total: number | null }>(`/trajectory/calls/${after}/diff?against=${before}&stage=effective&limit=25`, 0, "offset");
  const first = resource.pages[0];
  return <div className="trajectory-diff">{first && (!first.comparable ? <p>{tr("trajectory.coverage.incomplete")}</p> : first.total === 0 ? <p>{tr("trajectory.diff.unchanged")}</p> : <div className="mono muted">{first.total}</div>)}{resource.pages.flatMap(page => page.changes).map(change => <section key={change.path} className={`trajectory-change ${change.action}`}><header><Badge>{tr(change.action === "add" ? "trajectory.diff.add" : change.action === "remove" ? "trajectory.diff.remove" : "trajectory.diff.change")}</Badge><code>{change.path}</code></header><div className="trajectory-diff-columns"><pre>{change.before as string ?? "—"}</pre><pre>{change.after as string ?? "—"}</pre></div>{change.truncated && <small>{tr("trajectory.diff.preview")}</small>}</section>)}{resource.error && <div role="alert" className="form-error">{resource.error}<Button onClick={() => void resource.load()}>{tr("common.retry")}</Button></div>}<AutoPage more={resource.more} loading={resource.loading} load={resource.load}/></div>;
}

export function SnapshotInspector({id,stage}:{id:string;stage:CaptureStage|"node"}){return <InspectorWindow key={`${id}:${stage}`} id={id} stage={stage} endpoint={`/trajectory/snapshots/${id}/inspect?stage=${stage}`}/>;}
