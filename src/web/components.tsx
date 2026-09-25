import { Children, cloneElement, isValidElement, useEffect, useMemo, useState, type ButtonHTMLAttributes, type ComponentType, type HTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowClockwise, ArrowLeft, ArrowRight, Check, CircleNotch, Copy, MagnifyingGlass, Moon, X } from "@phosphor-icons/react";
import { useI18n } from "./i18n";

export type Icon = ComponentType<{ size?: number; weight?: "thin" | "light" | "regular" | "bold" | "fill" | "duotone"; className?: string }>;
export type RecordValue = Record<string, unknown>;

function localizeNode(node: ReactNode, translate: (value: string) => string): ReactNode {
  if (typeof node === "string") return translate(node);
  if (Array.isArray(node)) return Children.map(node, (item) => localizeNode(item, translate));
  if (!isValidElement(node)) return node;
  const children = (node.props as { children?: ReactNode }).children;
  if (children === undefined) return node;
  return cloneElement(node, {}, localizeNode(children, translate));
}

export function Button({ children, variant = "default", busy = false, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "quiet" | "danger"; busy?: boolean }) {
  const { translate } = useI18n();
  return <button type={props.type ?? "button"} className={`button button-${variant} ${className}`} {...props} disabled={props.disabled || busy}>{busy ? <CircleNotch className="spin" size={15} /> : null}{localizeNode(children, translate)}</button>;
}

export function IconButton({ label, children, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type={props.type ?? "button"} className={`icon-button ${className}`} aria-label={label} title={label} {...props}>{children}</button>;
}

export function Panel({ children, className = "", ...props }: HTMLAttributes<HTMLElement>) { const { translate } = useI18n(); return <section className={`panel ${className}`} {...props}>{localizeNode(children, translate)}</section>; }
export function Stack({ children, className = "" }: { children: ReactNode; className?: string }) { const { translate } = useI18n(); return <div className={`stack ${className}`}>{localizeNode(children, translate)}</div>; }
export function Section({ title, icon: IconComponent, actions, children, className = "" }: { title: string; icon?: Icon; actions?: ReactNode; children: ReactNode; className?: string }) { const { translate } = useI18n(); return <section className={`section ${className}`}><div className="section-heading"><div className="section-title">{IconComponent ? <IconComponent size={15} /> : null}<h2>{translate(title)}</h2></div>{actions ? <div className="section-actions">{localizeNode(actions, translate)}</div> : null}</div>{localizeNode(children, translate)}</section>; }

export function PageHeader({ icon: IconComponent, title, description, status, actions }: { icon: Icon; title: string; description?: string; status?: string; actions?: ReactNode }) {
  const { translate } = useI18n();
  return <header className="page-header"><div className="page-heading"><span className="page-heading-icon"><IconComponent size={17} weight="duotone" /></span><div className="min-width-0"><div className="page-title-row"><h1>{translate(title)}</h1>{status ? <span className="header-status">{translate(status)}</span> : null}</div>{description ? <p className="page-description">{translate(description)}</p> : null}</div></div>{actions ? <div className="page-actions">{localizeNode(actions, translate)}</div> : null}</header>;
}

export function DetailHeader({ title, eyebrow, description, onBack, actions }: { title: string; eyebrow?: string; description?: ReactNode; onBack?: () => void; actions?: ReactNode }) {
  const { translate } = useI18n();
  return <div className="detail-header">{onBack ? <Button className="detail-back" variant="quiet" onClick={onBack}><ArrowLeft size={15} />Back</Button> : null}<div className="detail-heading"><span className="eyebrow">{translate(eyebrow || "DETAIL")}</span><h2 title={title}>{translate(title)}</h2>{description ? <p>{localizeNode(description, translate)}</p> : null}</div>{actions ? <div className="detail-actions">{localizeNode(actions, translate)}</div> : null}</div>;
}

export function StatCard({ icon: IconComponent, label, value, detail, tone = "default" }: { icon?: Icon; label: string; value: ReactNode; detail?: ReactNode; tone?: "default" | "accent" | "danger" }) { return <div className={`stat-card stat-${tone}`}><div className="stat-label">{IconComponent ? <IconComponent size={14} /> : null}{label}</div><strong>{value}</strong>{detail ? <span>{detail}</span> : null}</div>; }
export function StatusBadge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "success" | "warning" | "danger" | "accent" }) { return <span className={`status-badge status-${tone}`}><span className="status-dot" />{children}</span>; }

export function DataTable({ columns, rows, empty = "No records", onRowClick, activeRowId }: { columns: { key: string; label: string; render?: (row: RecordValue) => ReactNode }[]; rows: RecordValue[]; empty?: string; onRowClick?: (row: RecordValue) => void; activeRowId?: string | number }) {
  const { translate } = useI18n();
  if (!rows.length) return <EmptyState title={empty} />;
  return <div className="table-scroll"><table className="data-table"><thead><tr>{columns.map((column) => <th key={column.key}>{translate(column.label)}</th>)}{onRowClick ? <th className="table-action-heading"><span className="sr-only">Open</span></th> : null}</tr></thead><tbody>{rows.map((row, index) => { const rowId = String(row.id ?? row.key ?? index); const active = activeRowId !== undefined && rowId === String(activeRowId); return <tr key={rowId} aria-selected={active || undefined} onClick={onRowClick ? () => onRowClick(row) : undefined} onKeyDown={onRowClick ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onRowClick(row); } } : undefined} tabIndex={onRowClick ? 0 : undefined} className={`${onRowClick ? "is-clickable" : ""} ${active ? "is-active" : ""}`}>{columns.map((column) => <td key={column.key}>{localizeNode(column.render ? column.render(row) : <span className="break-anywhere">{displayValue(row[column.key])}</span>, translate)}</td>)}{onRowClick ? <td className="table-action"><ArrowRight size={15} aria-hidden="true" /></td> : null}</tr>; })}</tbody></table></div>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) { const { translate } = useI18n(); return <label className="field"><span>{translate(label)}</span>{children}{hint ? <small>{localizeNode(hint, translate)}</small> : null}</label>; }
export function EmptyState({ title, action }: { title: string; action?: ReactNode }) { const { translate } = useI18n(); return <div className="empty-state"><span className="empty-mark">—</span><strong>{translate(title)}</strong>{localizeNode(action, translate)}</div>; }
export function Loading({ label = "Loading" }: { label?: string }) { const { translate } = useI18n(); return <div className="loading-state"><CircleNotch className="spin" size={19} /><span>{translate(label)}</span></div>; }
export function ErrorBox({ error }: { error?: string }) { return error ? <div className="form-error" role="alert">{error}</div> : null; }
export function Toolbar({ children }: { children: ReactNode }) { return <div className="toolbar-row">{children}</div>; }
export function ToolbarButton({ label, kind, onClick }: { label: string; kind: "refresh" | "theme" | "close"; onClick?: () => void }) { const { translate } = useI18n(); const IconComponent = kind === "refresh" ? ArrowClockwise : kind === "theme" ? Moon : X; return <IconButton label={translate(label)} onClick={onClick}><IconComponent size={17} /></IconButton>; }

export function Modal({ title, children, open, onOpenChange, wide = false }: { title: string; children: ReactNode; open: boolean; onOpenChange: (open: boolean) => void; wide?: boolean }) {
  if (!open) return null;
  return <ModalPortal title={title} open={open} onOpenChange={onOpenChange} wide={wide}>{children}</ModalPortal>;
}

function ModalPortal({ title, children, open, onOpenChange, wide }: { title: string; children: ReactNode; open: boolean; onOpenChange: (open: boolean) => void; wide: boolean }) {
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [open]);
  return createPortal(<div className="modal-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onOpenChange(false); }}><section className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}><div className="modal-header"><h2>{title}</h2><IconButton label="Close" onClick={() => onOpenChange(false)}><X size={17} /></IconButton></div><div className="modal-body">{children}</div></section></div>, document.body);
}

export function Confirm({ title, description, children, onConfirm, variant = "danger" }: { title: string; description?: string; children: ReactNode; onConfirm: () => Promise<void> | void; variant?: "danger" | "primary" }) {
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  return <><span onClick={() => setOpen(true)}>{children}</span><Modal title={title} open={open} onOpenChange={setOpen}><p className="confirm-copy">{description || "This action cannot be undone."}</p><ErrorBox error={error} /><div className="form-actions"><Button variant="quiet" onClick={() => setOpen(false)}>Cancel</Button><Button variant={variant} busy={busy} onClick={async () => { setBusy(true); setError(""); try { await onConfirm(); setOpen(false); } catch (reason) { setError(reason instanceof Error ? reason.message : "Request failed"); } finally { setBusy(false); } }}>Confirm</Button></div></Modal></>;
}

export function CopyButton({ value, label = "Copy" }: { value: unknown; label?: string }) {
  const [copied, setCopied] = useState(false); const text = toReadableText(value);
  return <Button variant="quiet" onClick={async () => { await navigator.clipboard?.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1400); }}><Copy size={14} />{copied ? "Copied" : label}</Button>;
}

function decodeValue(value: unknown, depth = 0): unknown {
  if (depth > 4 || typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try { const parsed = JSON.parse(trimmed); if (parsed !== value) return decodeValue(parsed, depth + 1); } catch {}
  const unescaped = value.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  if (unescaped !== value) { try { return decodeValue(JSON.parse(unescaped), depth + 1); } catch {} return unescaped; }
  return value;
}

function isMessage(value: unknown): value is RecordValue { return Boolean(value && typeof value === "object" && !Array.isArray(value) && ("role" in value || "speaker" in value) && ("content" in value || "text" in value || "message" in value)); }
function messageText(value: RecordValue) { return value.content ?? value.text ?? value.message ?? ""; }

export function StructuredValue({ value, label, initiallyOpen = true, depth = 0 }: { value: unknown; label?: string; initiallyOpen?: boolean; depth?: number }) {
  const readable = useMemo(() => decodeValue(value), [value]);
  if (readable === null || readable === undefined || readable === "") return <div className="value-empty">{label ? `${label}: ` : ""}—</div>;
  if (typeof readable !== "object") return <div className="value-text">{label ? <span className="value-label">{label}</span> : null}<span className="break-anywhere">{String(readable)}</span></div>;
  if (Array.isArray(readable)) {
    const messages = readable.length > 0 && readable.every(isMessage);
    if (messages) return <div className="message-stack">{readable.map((item, index) => <article className={`message-bubble role-${String(item.role || item.speaker).toLowerCase()}`} key={String(item.id ?? index)}><div className="message-meta"><strong>{String(item.role || item.speaker)}</strong>{item.name ? <span>{String(item.name)}</span> : null}</div><ContentBlock value={messageText(item)} compact /></article>)}</div>;
    return <div className="structured-list">{readable.length ? readable.map((item, index) => <details key={index} open={initiallyOpen && depth < 1} className="structured-item"><summary><span>Item {index + 1}</span><span className="muted">{valueKind(item)}</span></summary><div className="structured-item-body"><StructuredValue value={item} depth={depth + 1} /></div></details>) : <div className="value-empty">Empty list</div>}</div>;
  }
  const entries = Object.entries(readable as RecordValue);
  return <div className={`structured-object ${depth ? "nested" : ""}`}>{label ? <div className="value-label object-label">{label}</div> : null}{entries.length ? entries.map(([key, item]) => <div className="value-row" key={key}><div className="value-key">{humanize(key)}</div><div className="value-content"><StructuredValue value={item} depth={depth + 1} /></div></div>) : <div className="value-empty">Empty object</div>}</div>;
}

export function ContentBlock({ value, title, allowRaw = true, compact = false }: { value: unknown; title?: string; allowRaw?: boolean; compact?: boolean }) {
  const [raw, setRaw] = useState(false); const readable = useMemo(() => decodeValue(value), [value]); const rawText = useMemo(() => rawTextFor(value), [value]);
  return <div className={`content-block ${compact ? "content-block-compact" : ""}`}>{title ? <div className="content-block-head"><strong>{title}</strong><div className="content-block-actions"><CopyButton value={rawText} />{allowRaw ? <Button variant="quiet" onClick={() => setRaw((current) => !current)}>{raw ? "Readable" : "Raw"}</Button> : null}</div></div> : null}{raw ? <pre className="raw-block">{rawText || "—"}</pre> : <StructuredValue value={readable} />}</div>;
}

export function Timeline({ items, render }: { items: RecordValue[]; render?: (item: RecordValue, index: number) => ReactNode }) {
  if (!items.length) return <EmptyState title="No timeline events" />;
  return <div className="timeline">{items.map((item, index) => <article className="timeline-item" key={String(item.id ?? item.key ?? index)}><span className="timeline-marker" /><div className="timeline-card">{render ? render(item, index) : <><div className="timeline-meta"><strong>{String(item.kind || item.type || item.role || "Event")}</strong><span>{formatDate(item.timestamp ?? item.createdAt ?? item.at)}</span></div><ContentBlock value={item.text ?? item.content ?? item.detail ?? item} /></>}</div></article>)}</div>;
}

export function AppShell({ nav, page, title, children, onNavigate, onRefresh, onToggleTheme, theme, locale, onToggleLocale, search, onSearch, online }: { nav: { id: string; label: string; icon: Icon }[]; page: string; title: string; children: ReactNode; onNavigate: (page: string) => void; onRefresh: () => void; onToggleTheme: () => void; theme: "light" | "dark"; locale: string; onToggleLocale: () => void; search: string; onSearch: (value: string) => void; online: boolean }) {
  const { t } = useI18n();
  return <div className="app-shell"><aside className="sidebar"><button className="brand-button" type="button" onClick={() => onNavigate("overview")} aria-label={t("page.overview.title")}><span className="brand-mark">P</span><span><b>{t("brand.name")}</b><small>{t("brand.sub")}</small></span></button><div className="rail-section-label">{t("workspace.name")}</div><nav className="sidebar-nav">{nav.map((item) => { const IconComponent = item.icon; return <button type="button" key={item.id} className={`nav-item ${page === item.id ? "active" : ""}`} onClick={() => onNavigate(item.id)}><IconComponent size={17} weight={page === item.id ? "fill" : "regular"} /><span>{item.label}</span></button>; })}</nav><div className="sidebar-footer"><span className={`connection-dot ${online ? "online" : "offline"}`} />{online ? t("status.online") : t("status.disconnected")}<span className="mono">:{location.port || "80"}</span></div></aside><main className={`main-area page-${page}`}><header className="topbar"><div className="topbar-title"><span className="eyebrow">{t("workspace.local")}</span><strong>{title}</strong></div><div className="topbar-tools"><label className="search-box"><MagnifyingGlass size={16} /><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder={t("nav.search")} aria-label={t("nav.search")} /></label><ToolbarButton kind="refresh" label="Refresh" onClick={onRefresh} /><ToolbarButton kind="theme" label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} onClick={onToggleTheme} /><button type="button" className="locale-button" onClick={onToggleLocale} aria-label={t("language.switch")}>{locale === "zh-CN" ? "中" : "EN"}</button></div></header><div className="content-viewport"><div className="page-content">{children}</div></div><nav className="mobile-nav">{nav.slice(0, 5).map((item) => { const IconComponent = item.icon; return <button type="button" key={item.id} className={page === item.id ? "active" : ""} onClick={() => onNavigate(item.id)}><IconComponent size={18} /><span>{item.label}</span></button>; })}</nav></main></div>;
}

export function LoginCard({ onLogin }: { onLogin: (token: string) => Promise<void> }) { const [token, setToken] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); return <div className="login-shell"><form className="login-card" onSubmit={async (event) => { event.preventDefault(); setBusy(true); setError(""); try { await onLogin(token.trim()); } catch { setError("Invalid token"); } finally { setBusy(false); } }}><div className="login-brand"><span className="brand-mark">P</span><span><b>personal</b><small>gateway</small></span></div><h1>Connect to gateway</h1><p>Enter the local admin token to open the workspace.</p><Field label="Admin token"><input autoFocus type="password" value={token} onChange={(event) => setToken(event.target.value)} required /></Field><ErrorBox error={error} /><Button variant="primary" busy={busy} type="submit"><Check size={15} />Connect</Button></form></div>; }

function valueKind(value: unknown) { if (Array.isArray(value)) return `${value.length} items`; if (value && typeof value === "object") return `${Object.keys(value).length} fields`; return typeof value; }
function humanize(value: string) { return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").replace(/^./, (letter) => letter.toUpperCase()); }
function rawTextFor(value: unknown) { if (typeof value === "string") return value; try { return JSON.stringify(value, null, 2); } catch { return String(value); } }
function toReadableText(value: unknown) { const parsed = decodeValue(value); return typeof parsed === "string" ? parsed : rawTextFor(parsed); }
function displayValue(value: unknown) { if (value === null || value === undefined || value === "") return "—"; if (typeof value === "object") return valueKind(value); return String(value); }
function formatDate(value: unknown) { const number = Number(value); return Number.isFinite(number) && number > 0 ? new Date(number).toLocaleString() : "—"; }
