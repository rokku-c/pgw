import { tr, trError } from "./i18n";
import { StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider, LanguageSwitch, useI18n, type I18nKey } from "./i18n";
import { Tooltip } from "radix-ui";
import { SquaresFourIcon, HexagonIcon, PulseIcon, ChatCircleTextIcon, StackIcon, FingerprintIcon, PlayCircleIcon, SlidersHorizontalIcon, ArrowUpRightIcon, ArrowRightIcon, PlusIcon, CommandIcon, CircleIcon, SignOutIcon, ListIcon, XIcon, LightningIcon, CheckIcon, ShieldCheckIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { api, useResource } from "./api";
import { Button, IconButton, Modal, Field, Loading } from "./components";
import { TrajectoryWorkbench } from "./trajectory-workbench";
import { JobsPage, JobIndicator } from "./jobs";
import { PlaygroundPage } from "./playground";
import { Overview, Models, TrafficPage, SessionsPage, RegistryPage, PersonaPage, SettingsPage, RunsPage } from "./pages";
import type { Page, GatewayStatus } from "../shared/types";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles.css";

const bootstrapToken = new URLSearchParams(location.hash.slice(1)).get("token");
if (bootstrapToken) history.replaceState(null, "", location.pathname);

const navigation: { id: Page; label: I18nKey; icon: typeof SquaresFourIcon; key: string }[] = [
  { id: "overview", label: "nav.overview", icon: SquaresFourIcon, key: "1" },
  { id: "models", label: "nav.models", icon: HexagonIcon, key: "2" },
  { id: "traffic", label: "nav.traffic", icon: PulseIcon, key: "3" },
  { id: "observability", label: "nav.observability", icon: PulseIcon, key: "10" },
  { id: "sessions", label: "nav.sessions", icon: ChatCircleTextIcon, key: "4" },
  { id: "registry", label: "nav.registry", icon: StackIcon, key: "5" },
  { id: "persona", label: "nav.persona", icon: FingerprintIcon, key: "6" },
  { id: "runs", label: "nav.runs", icon: PlayCircleIcon, key: "7" },
  { id: "playground", label: "nav.playground", icon: LightningIcon, key: "9" },
  { id: "jobs", label: "nav.jobs", icon: PulseIcon, key: "0" },
  { id: "settings", label: "nav.settings", icon: SlidersHorizontalIcon, key: "8" },
];
function ConnectionState() {
  const { t } = useI18n();
  const status = useResource<GatewayStatus>("/status", 5000);
  return <div className="sidebar-status"><span className={status.error ? "tiny-dot" : "live-dot"}/><span>{status.error ? t("status.disconnected") : t("status.online")}</span><span className="mono">:{location.port || "80"}</span></div>;
}
function Logo() { return <svg width="29" height="29" viewBox="0 0 64 64" aria-hidden="true"><path d="M14 47V17h23a12 12 0 0 1 0 24H25V28" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round"/><circle cx="50" cy="48" r="4" fill="currentColor"/></svg>; }
function Login({ onLogin }: { onLogin: () => void }) {
  const { t } = useI18n();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <div className="login-shell"><div className="login-orbit"/><form className="login-card" onSubmit={async event => { event.preventDefault(); setBusy(true); try { await api("/auth/session", { method: "POST", body: JSON.stringify({ token: token.trim() }) }); onLogin(); } catch { setError("error.credentials"); } finally { setBusy(false); } }}><div className="login-brand"><LanguageSwitch/><Logo/><span>{t("brand.name")} {t("brand.sub")}</span></div><h1>{t("login.title")}</h1><Field label={t("login.token")}><input type="password" autoFocus autoComplete="off" value={token} onChange={e => setToken(e.target.value)} required/></Field>{error && <div role="alert" className="form-error">{trError(error)}</div>}<Button className="primary login-submit" busy={busy} type="submit">{t("login.connect")}<ArrowRightIcon size={18}/></Button><div className="login-foot"><ShieldCheckIcon size={15}/> {t("login.local")}</div></form></div>;
}
function App() {
  const { t } = useI18n();
  const [connected, setConnected] = useState<boolean>();
  const [page, setPage] = useState<Page>((location.pathname.split("/")[2] as Page) || "overview");
  const [commandOpen, setCommandOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [mobile, setMobile] = useState(false);
  const navigate = (next: Page) => { history.pushState(null, "", `/app/${next}`); setPage(next); setMobile(false); setCommandOpen(false); };
  useEffect(() => {
    let cancelled = false;
    const connect = async () => {
      if (bootstrapToken) await api("/auth/session", { method: "POST", body: JSON.stringify({ token: bootstrapToken }) });
      await api("/status"); if (!cancelled) setConnected(true);
    };
    void connect().catch(() => { if (!cancelled) setConnected(false); });
    const unauthorized = () => setConnected(false);
    const pop = () => setPage((location.pathname.split("/")[2] as Page) || "overview");
    window.addEventListener("pgw:unauthorized", unauthorized); window.addEventListener("popstate", pop);
    return () => { cancelled = true; window.removeEventListener("pgw:unauthorized", unauthorized); window.removeEventListener("popstate", pop); };
  }, []);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setCommandOpen(v => !v); }
      if ((event.metaKey || event.ctrlKey) && navigation.some(n => n.key === event.key)) { event.preventDefault(); navigate(navigation.find(n => n.key === event.key)!.id); }
    };
    window.addEventListener("keydown", keyboard); return () => window.removeEventListener("keydown", keyboard);
  }, []);
  if (connected === undefined) return <Loading/>;
  if (!connected) return <Login onLogin={() => setConnected(true)}/>;
  const current = navigation.find(n => n.id === page) || navigation[0];
  return <div className="app-shell"><div className="background-glow"/>{mobile && <button aria-label={t("common.close")} className="nav-backdrop" onClick={() => setMobile(false)}/>}
    <aside className={`sidebar ${mobile ? "mobile-open" : ""}`}><a href="/app/overview" className="brand" onClick={event => { event.preventDefault(); navigate("overview"); }}><Logo/><span>{t("brand.name")}<span>{t("brand.sub")}</span></span><span className="brand-dot"/></a>
      <button className="workspace-button" onClick={() => navigate("settings")}><span className="workspace-icon"><CommandIcon size={18}/></span><span>{t("workspace.name")}<small>{t("workspace.local")}</small></span><ArrowUpRightIcon size={14}/></button>
      <div className="nav-label">WORKSPACE</div><nav aria-label={tr("nav.primary")}>{navigation.filter(n=>n.id!=="settings").map(item => <a href={`/app/${item.id}`} key={item.id} className={`nav-item ${current.id === item.id ? "active" : ""}`} onClick={event => { event.preventDefault(); navigate(item.id); }} aria-current={current.id === item.id ? "page" : undefined}><item.icon size={20} weight={current.id === item.id ? "duotone" : "light"}/><span>{t(item.label)}</span>{current.id === item.id && <span className="nav-active-mark"/>}</a>)}</nav>
      <div className="sidebar-bottom"><button className="search-launch" onClick={() => setCommandOpen(true)}><MagnifyingGlassIcon size={17}/><span>{t("nav.search")}</span><kbd>⌘ K</kbd></button><a href="/app/settings" className={`nav-item ${page === "settings" ? "active" : ""}`} onClick={event => { event.preventDefault(); navigate("settings"); }}><SlidersHorizontalIcon size={20} weight="light"/><span>{t("nav.settings")}</span></a><ConnectionState/></div>
    </aside>
    <main className="main"><header className="topbar"><div className="topbar-controls"><IconButton label={tr("nav.toggle")} className="mobile-menu" onClick={() => setMobile(true)}><ListIcon size={18}/></IconButton></div><div className="topbar-right"><LanguageSwitch/><JobIndicator open={()=>navigate("jobs")}/><span className="local-badge"><ShieldCheckIcon size={14}/> {t("status.local")}</span><button className="avatar" onClick={() => navigate("settings")} aria-label={t("nav.settings")}>P</button></div></header><div className={`page ${current.id}-page`} key={current.id}>
      {current.id === "jobs" && <JobsPage/>}{current.id === "playground" && <PlaygroundPage/>}{current.id === "overview" && <Overview navigate={navigate}/>}{current.id === "models" && <Models/>}{current.id === "traffic" && <TrafficPage/>}{current.id === "observability" && <TrajectoryWorkbench/>}{current.id === "sessions" && <SessionsPage/>}{current.id === "registry" && <RegistryPage/>}{current.id === "persona" && <PersonaPage/>}{current.id === "runs" && <RunsPage/>}{current.id === "settings" && <SettingsPage/>}
    </div></main>
    <Modal title={t("nav.search")} open={commandOpen} onOpenChange={setCommandOpen}><div className="command-search"><MagnifyingGlassIcon size={20}/><input autoFocus aria-label={t("nav.search")} placeholder={t("common.search")} value={query} onChange={e => setQuery(e.target.value)}/></div><div className="command-items">{navigation.filter(n => t(n.label).toLowerCase().includes(query.toLowerCase()) || n.id.includes(query.toLowerCase())).map(n => <button key={n.id} onClick={() => navigate(n.id)}><n.icon size={20} weight="light"/><span>{t(n.label)}</span><kbd>⌘ {n.key}</kbd></button>)}</div></Modal>
  </div>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><I18nProvider><Tooltip.Provider delayDuration={200}><App/></Tooltip.Provider></I18nProvider></StrictMode>);
