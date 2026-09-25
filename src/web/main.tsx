import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Briefcase, ChartLine, ChatsCircle, Code, Gear, ListChecks, Package, PlayCircle, Pulse, Robot, ShieldCheck, SlidersHorizontal, SquaresFour, TerminalWindow, UserCircle } from "@phosphor-icons/react";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles.css";
import { api, get, send } from "./api";
import { I18nProvider, useI18n } from "./i18n";
import type { Page } from "../shared/types";
import { AppShell, Button, ContentBlock, DataTable, EmptyState, Field, Loading, LoginCard, PageHeader, Panel, StatCard, StatusBadge, type Icon } from "./components";
import { CompleteJobsPage, CompleteObservabilityPage, CompletePersonaPage, CompleteRegistryPage, CompleteSessionsPage, JobsPage, ModelsPage, ObservabilityPage, PersonaPage, PlaygroundPage, RegistryPage, RunsPage, SessionsPage, SettingsPage, TrafficPage } from "./high-value-pages";
import { CompleteObservabilityPage as ReadingObservabilityPage, CompleteSessionsPage as ReadingSessionsPage, TrafficPage as ReadingTrafficPage } from "./reading-pages";
import { ControlPage } from "./control-page";

type Row = Record<string, unknown>;
const pages: { id: Page; label: string; icon: Icon }[] = [
  { id: "overview", label: "Overview", icon: SquaresFour }, { id: "models", label: "Models", icon: Robot }, { id: "traffic", label: "Traffic", icon: ChartLine }, { id: "observability", label: "Observe", icon: Pulse }, { id: "sessions", label: "Sessions", icon: ChatsCircle }, { id: "registry", label: "Registry", icon: Package }, { id: "persona", label: "Persona", icon: UserCircle }, { id: "runs", label: "Runs", icon: PlayCircle }, { id: "playground", label: "Playground", icon: TerminalWindow }, { id: "jobs", label: "Jobs", icon: ListChecks }, { id: "control", label: "Control", icon: ShieldCheck }, { id: "settings", label: "Settings", icon: Gear },
];
const pageMeta: Record<Page, { title: string; description: string; icon: Icon }> = Object.fromEntries(pages.map((item) => [item.id, { title: item.label, description: `Manage local ${item.label.toLowerCase()} and gateway activity.`, icon: item.icon }])) as Record<Page, { title: string; description: string; icon: Icon }>;

function routePage(): Page { const value = location.pathname.split("/")[2] as Page; return pages.some((item) => item.id === value) ? value : "overview"; }

function App() {
  const { locale, setLocale, t } = useI18n();
  const [connected, setConnected] = useState<boolean | undefined>();
  const [page, setPage] = useState<Page>(routePage());
  const [theme, setTheme] = useState<"light" | "dark">(() => (localStorage.getItem("pgw-theme") as "light" | "dark") || "light");
  const [search, setSearch] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("pgw-theme", theme); }, [theme]);
  useEffect(() => { const bootstrap = new URLSearchParams(location.hash.slice(1)).get("token"); if (bootstrap) { history.replaceState(null, "", location.pathname); void api("/auth/session", { method: "POST", body: JSON.stringify({ token: bootstrap }) }).then(() => setConnected(true)).catch(() => setConnected(false)); } else { void get("/status").then(() => setConnected(true)).catch(() => setConnected(false)); } const onPop = () => setPage(routePage()); addEventListener("popstate", onPop); return () => removeEventListener("popstate", onPop); }, []);
  const navigate = useCallback((next: string) => { const target = next as Page; history.pushState(null, "", `/app/${target}`); setPage(target); setSearch(""); }, []);
  const login = async (token: string) => { await api("/auth/session", { method: "POST", body: JSON.stringify({ token }) }); setConnected(true); };
  const localizedPages = useMemo(() => pages.map((item) => ({ ...item, label: t(item.id === "observability" ? "nav.observability" : `nav.${item.id}`) })), [t]);
  const localizedTitle = t(page === "overview" || page === "control" ? `page.${page}.title` : page === "observability" ? "page.observability.title" : `page.${page}.title`);
  if (connected === undefined) return <Loading label="Connecting" />;
  if (!connected) return <LoginCard onLogin={login} />;
  return <AppShell nav={localizedPages} page={page} title={localizedTitle} onNavigate={navigate} onRefresh={() => setRefreshKey((value) => value + 1)} onToggleTheme={() => setTheme((value) => value === "dark" ? "light" : "dark")} theme={theme} locale={locale} onToggleLocale={() => setLocale(locale === "zh-CN" ? "en-US" : "zh-CN")} search={search} onSearch={setSearch} online={connected}><RouteView page={page} search={search} refreshKey={refreshKey} navigate={navigate} /></AppShell>;
}

function RouteView({ page, search, refreshKey, navigate }: { page: Page; search: string; refreshKey: number; navigate: (page: string) => void }) {
  const { t } = useI18n();
  const meta = { ...pageMeta[page], title: t(page === "overview" || page === "control" ? `page.${page}.title` : page === "observability" ? "page.observability.title" : `page.${page}.title`), description: t(`page.${page}.description`) };
  if (page === "overview") return <Overview refreshKey={refreshKey} navigate={navigate} />;
  if (page === "models") return <ModelsPage />;
  if (page === "traffic") return <ReadingTrafficPage />;
  if (page === "sessions") return <ReadingSessionsPage />;
  if (page === "runs") return <RunsPage />;
  if (page === "registry") return <CompleteRegistryPage />;
  if (page === "persona") return <CompletePersonaPage />;
  if (page === "jobs") return <CompleteJobsPage />;
  if (page === "control") return <ControlPage />;
  if (page === "settings") return <SettingsPage />;
  if (page === "playground") return <PlaygroundPage />;
  if (page === "observability") return <ReadingObservabilityPage />;
  return <ResourcePage key={`${page}-${refreshKey}`} page={page} meta={meta} search={search} navigate={navigate} />;
}

function Overview({ refreshKey, navigate }: { refreshKey: number; navigate: (page: string) => void }) {
  const [data, setData] = useState<Row | null>(null); const [loading, setLoading] = useState(true);
  useEffect(() => { setLoading(true); void get<Row>("/dashboard?recentLimit=8").then(setData).finally(() => setLoading(false)); }, [refreshKey]);
  if (loading && !data) return <><PageHeader icon={SquaresFour} title="Overview" status="Local" /><Loading /></>;
  const value = (key: string) => data?.[key] ?? 0;
  return <div className="screen-page overview-screen"><PageHeader icon={SquaresFour} title="Overview" description="A compact view of gateway health, throughput, and recent activity." status="Local" actions={<Button onClick={() => navigate("traffic")}>Open traffic</Button>} /><div className="stats-grid"><StatCard icon={ChartLine} label="Requests" value={display(value("requests"))} detail="last 24 hours" tone="accent" /><StatCard icon={Pulse} label="In flight" value={display(value("active"))} /><StatCard icon={Briefcase} label="Providers" value={display(value("providers"))} /><StatCard icon={Code} label="Tokens" value={formatNumber(value("tokens"))} /></div><div className="two-column overview-layout"><Panel><div className="panel-header"><h2>Recent requests</h2><StatusBadge tone="success">Gateway online</StatusBadge></div><div className="overview-table"><DataTable rows={Array.isArray(data?.recent) ? data.recent as Row[] : []} columns={[{ key: "model", label: "Model" }, { key: "providerName", label: "Provider" }, { key: "status", label: "Status", render: (row) => <StatusBadge tone={row.status === "failed" ? "danger" : row.status === "completed" ? "success" : "warning"}>{String(row.status ?? "unknown")}</StatusBadge> }, { key: "latencyMs", label: "Latency", render: (row) => `${String(row.latencyMs ?? "—")} ms` }]} empty="No requests yet" /></div></Panel><Panel><div className="panel-header"><h2>Workspace inventory</h2></div><div className="overview-inventory"><div className="stats-grid"><StatCard label="Agents" value={display(value("agents"))} /><StatCard label="Skills" value={display(value("skills"))} /><StatCard label="Sessions" value={display(value("sessions"))} /><StatCard label="Preferences" value={display(value("preferences"))} /></div></div></Panel></div></div>;
}

const resourceConfig: Record<Exclude<Page, "overview" | "settings" | "control">, { endpoint: string; columns: { key: string; label: string }[] }> = {
  models: { endpoint: "/providers", columns: [{ key: "name", label: "Name" }, { key: "protocol", label: "Protocol" }, { key: "baseUrl", label: "Base URL" }, { key: "health", label: "Health" }] },
  traffic: { endpoint: "/traffic?limit=80", columns: [{ key: "model", label: "Model" }, { key: "providerName", label: "Provider" }, { key: "status", label: "Status" }, { key: "latencyMs", label: "Latency" }, { key: "createdAt", label: "Created" }] },
  observability: { endpoint: "/observability", columns: [{ key: "enabled", label: "Enabled" }, { key: "retentionDays", label: "Retention" }, { key: "maxStorageBytes", label: "Storage" }] },
  sessions: { endpoint: "/sessions", columns: [{ key: "title", label: "Title" }, { key: "agent", label: "Agent" }, { key: "project", label: "Project" }, { key: "status", label: "Status" }] },
  registry: { endpoint: "/assets", columns: [{ key: "name", label: "Name" }, { key: "kind", label: "Kind" }, { key: "source", label: "Source" }, { key: "status", label: "Status" }] },
  persona: { endpoint: "/preferences", columns: [{ key: "title", label: "Preference" }, { key: "scope", label: "Scope" }, { key: "status", label: "Status" }, { key: "content", label: "Content" }] },
  runs: { endpoint: "/runs", columns: [{ key: "agent", label: "Agent" }, { key: "goal", label: "Goal" }, { key: "status", label: "Status" }, { key: "workspace", label: "Workspace" }] },
  playground: { endpoint: "/dashboard?recentLimit=20", columns: [{ key: "modelCalls", label: "Model calls" }, { key: "toolCalls", label: "Tool calls" }, { key: "latencyMs", label: "Latency" }] },
  jobs: { endpoint: "/jobs?limit=80", columns: [{ key: "label", label: "Job" }, { key: "kind", label: "Kind" }, { key: "status", label: "Status" }, { key: "phase", label: "Phase" }] },
};

function ResourcePage({ page, meta, search, navigate }: { page: Exclude<Page, "overview" | "settings" | "control">; meta: { title: string; description: string; icon: Icon }; search: string; navigate: (page: string) => void }) {
  const [data, setData] = useState<unknown>(); const [error, setError] = useState("");
  const config = resourceConfig[page];
  useEffect(() => { setError(""); void get<unknown>(config.endpoint).then(setData).catch((reason) => setError(reason instanceof Error ? reason.message : "Request failed")); }, [config.endpoint]);
  const rows = useMemo(() => rowsFromData(data).filter((row) => !search || JSON.stringify(row).toLowerCase().includes(search.toLowerCase())), [data, search]);
  const columns = config.columns.map((column) => ({ ...column, render: (row: Row) => column.key === "status" || column.key === "health" ? <StatusBadge tone={String(row[column.key]) === "failed" || String(row[column.key]) === "down" ? "danger" : String(row[column.key]) === "completed" || String(row[column.key]) === "up" ? "success" : "neutral"}>{String(row[column.key] ?? "unknown")}</StatusBadge> : column.key === "createdAt" ? formatDate(row[column.key]) : undefined }));
  return <><PageHeader icon={meta.icon} title={meta.title} description={meta.description} actions={<Button variant="primary" onClick={() => navigate("overview")}>Back to overview</Button>} />{error ? <Panel><div className="form-error">{error}</div></Panel> : <Panel><div className="panel-header"><h2>{meta.title}</h2><span className="muted">{rows.length} records</span></div>{data === undefined ? <Loading /> : <DataTable rows={rows} columns={columns} empty={`No ${meta.title.toLowerCase()} found`} />}</Panel>}</>;
}

function Settings({ refreshKey }: { refreshKey: number }) {
  const [settings, setSettings] = useState<Row | null>(null); const [busy, setBusy] = useState(false); const [saved, setSaved] = useState(false);
  useEffect(() => { void get<Row>("/settings").then(setSettings); }, [refreshKey]);
  const personalization = Boolean(settings?.personalization);
  return <><PageHeader icon={SlidersHorizontal} title="Settings" description="Local gateway policies and storage controls." /><div className="panel-grid"><Panel><div className="panel-header"><h2>Workspace</h2><StatusBadge tone="accent">Local only</StatusBadge></div><div className="field"><span>Personalization</span><Button busy={busy} onClick={async () => { setBusy(true); try { const result = await send<Row>("/settings", "PATCH", { personalization: !personalization }); setSettings((current) => ({ ...current, ...result })); setSaved(true); } finally { setBusy(false); } }}>{personalization ? "Enabled" : "Disabled"}</Button></div>{saved ? <p className="muted">Saved</p> : null}</Panel><Panel><div className="panel-header"><h2>Observability</h2></div><ContentBlock value={settings?.observability ?? {}} /></Panel></div></>;
}

function rowsFromData(data: unknown): Row[] { if (Array.isArray(data)) return data as Row[]; if (data && typeof data === "object") { const object = data as Row; if (Array.isArray(object.items)) return object.items as Row[]; return [object]; } return []; }
function formatNumber(value: unknown) { const number = Number(value); return Number.isFinite(number) ? new Intl.NumberFormat().format(number) : "—"; }
function formatDate(value: unknown) { const date = Number(value); return Number.isFinite(date) && date > 0 ? new Date(date).toLocaleString() : "—"; }
function display(value: unknown) { if (value === null || value === undefined || value === "") return "—"; return typeof value === "object" ? JSON.stringify(value) : String(value); }

createRoot(document.getElementById("root")!).render(<I18nProvider><App /></I18nProvider>);
