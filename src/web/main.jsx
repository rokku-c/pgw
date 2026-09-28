import { useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Activity, ArrowRight, Boxes, ChartNoAxesCombined, Check, ChevronDown,
  Command, Eye, Gauge, GitBranch, Globe2, KeyRound, LayoutDashboard, ListChecks,
  Menu, Moon, Network, Package, Play, Search, Settings2, Shield, Sun,
  TerminalSquare, UserRound, X,
} from 'lucide-react'
import { get, send } from './api'
import { WorkspacePage } from './workspace'
import './styles.css'

const navGroups = [
  { label: 'Workspace', items: [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'models', label: 'Models', icon: Network },
    { id: 'traffic', label: 'Traffic', icon: ChartNoAxesCombined },
    { id: 'observe', label: 'Observe', icon: Eye },
    { id: 'sessions', label: 'Sessions', icon: Activity },
    { id: 'registry', label: 'Registry', icon: Package },
    { id: 'persona', label: 'Persona', icon: UserRound },
    { id: 'runs', label: 'Runs', icon: Play },
    { id: 'playground', label: 'Playground', icon: TerminalSquare },
    { id: 'jobs', label: 'Jobs', icon: ListChecks },
  ] },
  { label: 'Control', items: [
    { id: 'control', label: 'Control', icon: Shield },
    { id: 'settings', label: 'Settings', icon: Settings2 },
  ] },
]

const pageByPath = () => {
  const slug = location.pathname.split('/').filter(Boolean).at(-1)
  if (slug === 'observability') return 'observe'
  return navGroups.flatMap((group) => group.items).some((item) => item.id === slug) ? slug : 'overview'
}

function App() {
  const [page, setPage] = useState(pageByPath)
  const [online, setOnline] = useState(null)
  const [loginError, setLoginError] = useState('')
  const [theme, setTheme] = useState(() => localStorage.getItem('pgw2-theme') || 'dark')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [toast, setToast] = useState('')

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('pgw2-theme', theme)
  }, [theme])

  useEffect(() => {
    const token = new URLSearchParams(location.hash.slice(1)).get('token')
    const verify = token
      ? send('/auth/session', 'POST', { token }).then(() => {
        history.replaceState(null, '', location.pathname)
        setOnline(true)
      })
      : get('/status').then(() => setOnline(true))
    void verify.catch((error) => {
      setLoginError(error instanceof Error ? error.message : 'Gateway unavailable')
      setOnline(false)
    })
    const onPopState = () => setPage(pageByPath())
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen(true)
      }
      if (event.key === 'Escape') {
        setPaletteOpen(false)
        setSidebarOpen(false)
      }
    }
    addEventListener('popstate', onPopState)
    addEventListener('keydown', onKeyDown)
    return () => {
      removeEventListener('popstate', onPopState)
      removeEventListener('keydown', onKeyDown)
    }
  }, [])

  useEffect(() => {
    if (!toast) return undefined
    const timer = setTimeout(() => setToast(''), 2800)
    return () => clearTimeout(timer)
  }, [toast])

  const navigate = useCallback((id, params = {}) => {
    const search = new URLSearchParams(params).toString()
    history.pushState(null, '', `/app/${id}${search ? `?${search}` : ''}`)
    setPage(id)
    setQuery('')
    setSidebarOpen(false)
  }, [])

  const notify = useCallback((message) => setToast(message), [])
  const activeItem = useMemo(() => navGroups.flatMap((group) => group.items).find((item) => item.id === page), [page])

  if (online === null) return <div className="boot-screen"><div className="boot-mark"><Boxes size={20} /></div><strong>Connecting to local gateway</strong><span>Checking the local API…</span></div>

  if (!online) return <LoginScreen error={loginError} onLogin={async (token) => {
    try {
      await send('/auth/session', 'POST', { token })
      setOnline(true)
      setLoginError('')
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Could not authenticate')
    }
  }} />

  return <div className="app-shell">
    {sidebarOpen && <button className="mobile-scrim" onClick={() => setSidebarOpen(false)} aria-label="Close navigation" />}
    <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <div className="brand-lockup"><div className="brand-mark"><Boxes size={18} /></div><div><div className="brand-name">gateway</div><div className="brand-version">PERSONAL · 2.0</div></div><button className="mobile-close" onClick={() => setSidebarOpen(false)} aria-label="Close navigation"><X size={17} /></button></div>
      <button className="workspace-switcher" onClick={() => navigate('overview')}><span className="avatar">PG</span><span className="workspace-copy"><strong>Local workspace</strong><small>Private · on this device</small></span><ChevronDown size={14} /></button>
      {navGroups.map((group) => <div className="nav-group" key={group.label}><div className="nav-label">{group.label}</div><nav className="main-nav">{group.items.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => navigate(id)} title={label}><Icon size={16} strokeWidth={1.8} /><span>{label}</span></button>)}</nav></div>)}
      <div className="sidebar-spacer" />
      <div className="sidebar-footer"><div className="system-status"><span className="status-dot" /> Gateway connected <span className="status-ping" /></div><span className="build-label"><Globe2 size={12} /> 127.0.0.1 · local only</span></div>
    </aside>

    <main className="main-content">
      <header className="topbar">
        <button className="mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Open navigation"><Menu size={18} /></button>
        <div className="crumbs"><span>Workspace</span><span className="crumb-divider">/</span><strong>{activeItem?.label || 'Overview'}</strong></div>
        <div className="top-actions"><label className="global-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search this view…" /><kbd>⌘ K</kbd></label><button className="icon-button" onClick={() => setRefreshKey((value) => value + 1)} aria-label="Refresh data" title="Refresh"><Activity size={16} /></button><button className="icon-button" onClick={() => setTheme((value) => value === 'dark' ? 'light' : 'dark')} aria-label="Toggle theme" title="Toggle theme">{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</button><span className="online-pill"><i /> Online</span></div>
      </header>
      <WorkspacePage key={`${page}-${refreshKey}`} page={page} query={query} refreshKey={refreshKey} navigate={navigate} notify={notify} />
      <footer className="main-footer"><span><GitBranch size={12} /> personal-gateway 2.0</span><span>Local-first · data stays on this device</span></footer>
    </main>

    {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} navigate={(id) => { setPaletteOpen(false); navigate(id) }} />}
    {toast && <div className="toast"><Check size={14} />{toast}</div>}
  </div>
}

function LoginScreen({ error, onLogin }) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  return <main className="login-screen"><section className="login-card"><div className="brand-mark"><KeyRound size={18} /></div><div className="eyebrow">LOCAL WORKSPACE</div><h1>Connect your gateway</h1><p>Start Personal Gateway on this device, then authenticate with its local access token.</p>{error && <div className="error-banner">{error.includes('Failed to fetch') || error.includes('NetworkError') ? 'Gateway API is not reachable at 127.0.0.1:7210. Start the gateway server, then retry.' : error}</div>}<form onSubmit={async (event) => { event.preventDefault(); setBusy(true); await onLogin(token.trim()); setBusy(false) }}><label htmlFor="gateway-token">Access token</label><input id="gateway-token" type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Paste local gateway token" required /><button className="primary-button" disabled={busy}>{busy ? 'Connecting…' : 'Connect'}<ArrowRight size={15} /></button></form><small>Token is only sent to your local gateway.</small></section></main>
}

function CommandPalette({ onClose, navigate }) {
  const [filter, setFilter] = useState('')
  const pages = navGroups.flatMap((group) => group.items).filter((item) => item.label.toLowerCase().includes(filter.toLowerCase()))
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="command-modal" onMouseDown={(event) => event.stopPropagation()}><div className="command-input"><Search size={16} /><input autoFocus value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Jump to a workspace…" /><kbd>esc</kbd></div><div className="command-label">Pages</div><div className="command-list">{pages.map(({ id, label, icon: Icon }) => <button key={id} className="command-row" onClick={() => navigate(id)}><Icon size={16} /><span>{label}</span><ArrowRight size={14} /></button>)}</div><div className="command-footer"><span><Command size={12} /> Search pages</span><span>esc Close</span></div></section></div>
}

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')
createRoot(root).render(<App />)
