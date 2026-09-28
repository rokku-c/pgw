import { useEffect, useMemo, useState } from 'react'
import {
  Activity, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, Bot, Check, CircleAlert, Clock3,
  Code2, Database, Download, Eye, FileJson2, Gauge, GitBranch, LoaderCircle, Play, Plus,
  RefreshCw, RotateCcw, Search, Settings2, Star, TerminalSquare, Trash2, X,
} from 'lucide-react'
import { get, send } from './api'

const pageMeta = {
  overview: ['Overview', 'Live health, recent requests, and workspace inventory.'],
  models: ['Models', 'Providers, model routes, and client access keys.'],
  traffic: ['Traffic', 'Inspect gateway requests, stages, attempts, and session links.'],
  observe: ['Observe', 'Follow a trajectory from session to node evidence.'],
  sessions: ['Sessions', 'Search and manage indexed agent sessions.'],
  registry: ['Registry', 'Assets, skills, roots, deployments, and inventory.'],
  persona: ['Persona', 'Manage learned preferences, evidence, and history.'],
  runs: ['Runs', 'Start, inspect, and control agent runs.'],
  playground: ['Playground', 'Send a real model request through a selected route.'],
  jobs: ['Jobs', 'Monitor background tasks, attempts, and results.'],
  control: ['Control', 'Review approvals, routing state, and MCP activity.'],
  settings: ['Settings', 'Gateway policies, observability, and local storage.'],
}

const baseLists = {
  providers: { path: '/providers', columns: ['name', 'protocol', 'baseUrl', 'health'] },
  routes: { path: '/routes', columns: ['alias', 'protocol', 'strategy', 'enabled'] },
  clients: { path: '/clients?limit=100', columns: ['name', 'kind', 'project', 'enabled', 'keyPreview'] },
  traffic: { path: '/traffic?limit=100', columns: ['model', 'clientName', 'providerName', 'status', 'latencyMs', 'createdAt'] },
  sessions: { path: '/sessions?limit=100', columns: ['title', 'agent', 'project', 'model', 'status', 'lastActiveAt'] },
  assets: { path: '/assets', columns: ['name', 'kind', 'source', 'status', 'version'] },
  preferences: { path: '/preferences', columns: ['title', 'scope', 'status', 'revision', 'updatedAt'] },
  runs: { path: '/runs', columns: ['agent', 'goal', 'status', 'workspace', 'updatedAt'] },
  jobs: { path: '/jobs?limit=100', columns: ['label', 'kind', 'status', 'phase', 'processed', 'total', 'createdAt'] },
}

const tabSets = {
  models: [['providers', 'Providers'], ['routes', 'Routes'], ['clients', 'Clients']],
  registry: [['assets', 'Assets'], ['skills', 'Skills'], ['roots', 'Asset roots'], ['deployments', 'Deployments'], ['mcp', 'MCP']],
  control: [['approvals', 'Approvals'], ['circuits', 'Circuits'], ['routing', 'Routing sessions'], ['mcp-calls', 'MCP calls']],
}

const tabLists = {
  skills: { path: '/skills?limit=100', columns: ['name', 'description', 'root', 'path', 'duplicate'] },
  roots: { path: '/asset-roots', columns: ['name', 'agent', 'path', 'enabled', 'capture'] },
  deployments: { path: '/asset-deployments', columns: ['assetId', 'target', 'status', 'createdAt'] },
  mcp: { path: '/mcp', columns: ['name', 'transport', 'url', 'status'] },
  approvals: { path: '/approvals', columns: ['kind', 'title', 'status', 'createdAt'] },
  circuits: { path: '/routing/circuits', columns: ['providerName', 'status', 'failures', 'openedAt'] },
  routing: { path: '/routing/sessions', columns: ['clientName', 'model', 'providerName', 'active', 'updatedAt'] },
  'mcp-calls': { path: '/mcp-calls?limit=100', columns: ['connectionName', 'kind', 'name', 'status', 'createdAt'] },
}

export function WorkspacePage({ page, query, refreshKey, navigate, notify }) {
  const [activeTab, setActiveTab] = useState(tabSets[page]?.[0]?.[0] || '')
  useEffect(() => setActiveTab(tabSets[page]?.[0]?.[0] || ''), [page])
  if (page === 'overview') return <OverviewPage navigate={navigate} refreshKey={refreshKey} query={query} />
  if (page === 'traffic') return <TrafficPage query={query} refreshKey={refreshKey} notify={notify} />
  if (page === 'observe') return <ObservePage query={query} refreshKey={refreshKey} notify={notify} />
  if (page === 'sessions') return <SessionsPage query={query} refreshKey={refreshKey} notify={notify} />
  if (page === 'persona') return <PersonaPage query={query} refreshKey={refreshKey} notify={notify} />
  if (page === 'runs') return <RunsPage query={query} refreshKey={refreshKey} notify={notify} />
  if (page === 'playground') return <PlaygroundPage notify={notify} />
  if (page === 'settings') return <SettingsPage notify={notify} />
  if (page === 'jobs') return <ListPage page={page} list={baseLists.jobs} query={query} refreshKey={refreshKey} notify={notify} />
  const tab = activeTab || tabSets[page]?.[0]?.[0]
  return <ListPage page={page} list={tabLists[tab] || baseLists[tab] || baseLists.providers} query={query} refreshKey={refreshKey} notify={notify} activeTab={tab} onTab={setActiveTab} />
}

function useResource(path, refreshKey = 0) {
  const [state, setState] = useState({ data: undefined, loading: true, error: '' })
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!path) {
      setState({ data: undefined, loading: false, error: '' })
      return undefined
    }
    let active = true
    setState((current) => ({ ...current, loading: true, error: '' }))
    get(path).then((data) => { if (active) setState({ data, loading: false, error: '' }) })
      .catch((error) => { if (active) setState({ data: undefined, loading: false, error: readableError(error) }) })
    return () => { active = false }
  }, [path, refreshKey, revision])
  return { ...state, refresh: () => setRevision((value) => value + 1), setData: (data) => setState((current) => ({ ...current, data })) }
}

function OverviewPage({ navigate, refreshKey, query }) {
  const resource = useResource('/dashboard?recentLimit=16', refreshKey)
  const data = resource.data || {}
  const recent = records(data.recent).filter((row) => matches(row, query))
  return <PageFrame page="overview" actions={<Button onClick={resource.refresh}><RefreshCw size={14} />Refresh</Button>}>
    {resource.error ? <ErrorPanel error={resource.error} /> : null}
    <div className="metric-grid">
      <Metric label="Requests" value={data.requests} detail="last 24 hours" icon={ArrowUpRight} />
      <Metric label="In flight" value={data.active} detail="live requests" icon={ActivityIcon} />
      <Metric label="Providers" value={data.providers} detail="enabled upstreams" icon={Bot} />
      <Metric label="Tokens" value={data.tokens} detail="processed" icon={Code2} />
    </div>
    <div className="overview-grid">
      <Panel title="Recent requests" count={recent.length} loading={resource.loading}>
        <DataTable rows={recent} columns={baseLists.traffic.columns} onSelect={(row) => navigate('traffic')} empty="No requests recorded yet." />
      </Panel>
      <div className="overview-side">
        <Panel title="Workspace inventory">
          <div className="inventory-grid">{[['Agents', data.agents, 'registry'], ['Skills', data.skills, 'registry'], ['Sessions', data.sessions, 'sessions'], ['Preferences', data.preferences, 'persona']].map(([label, value, route]) => <button className="inventory-item" key={label} onClick={() => navigate(route)}><span>{label}</span><strong>{formatValue(value)}</strong><ArrowUpRight size={13} /></button>)}</div>
        </Panel>
        <Panel title="Gateway status"><div className="gateway-card"><div className="gateway-orbit"><span><Gauge size={20} /></span></div><div><strong>Local gateway online</strong><small>Requests route through your local workspace.</small></div><span className="online-pill"><i />Ready</span></div></Panel>
        <Panel title="Quick actions"><div className="quick-actions"><button onClick={() => navigate('playground')}><TerminalSquare size={15} />Test a model</button><button onClick={() => navigate('models')}><Plus size={15} />Configure a route</button><button onClick={() => navigate('sessions')}><Search size={15} />Find a session</button></div></Panel>
      </div>
    </div>
  </PageFrame>
}

function ListPage({ page, list, query, refreshKey, activeTab, onTab, notify }) {
  const title = pageMeta[page]?.[0] || 'Workspace'
  const [offset, setOffset] = useState(0)
  const resourceName = activeTab || page
  const pageSize = 50
  const pageable = ['clients', 'jobs'].includes(resourceName)
  const listPath = pageable ? `/${resourceName}?limit=${pageSize}&offset=${offset}` : list.path
  const resource = useResource(listPath, refreshKey)
  const [selected, setSelected] = useState(null)
  const [error, setError] = useState('')
  const dataRows = records(resource.data)
  const rows = dataRows.filter((row) => matches(row, query))
  const columns = list.columns.map((key) => ({ key, label: humanize(key), render: key === 'status' || key === 'health' ? (row) => <Status value={row[key]} /> : key.toLowerCase().includes('at') || key.endsWith('At') ? (row) => formatDate(row[key]) : undefined }))
  const addable = ['providers', 'routes', 'clients', 'preferences', 'roots', 'mcp'].includes(activeTab || page)
  const doAction = async (action, row) => {
    setError('')
    const kind = activeTab || page
    try {
      if (kind === 'approvals' && window.confirm(`${action === 'accept' ? 'Approve' : 'Deny'} this request?`)) await send(`/approvals/${row.id}`, 'POST', { accept: action === 'accept' })
      else if (kind === 'mcp-calls' && action === 'accept' && window.confirm('Allow this MCP call?')) await send(`/mcp-calls/${row.id}/decide`, 'POST', { accept: true })
      else if (kind === 'mcp-calls' && action === 'deny' && window.confirm('Deny this MCP call?')) await send(`/mcp-calls/${row.id}/decide`, 'POST', { accept: false })
      else if (kind === 'mcp-calls' && action === 'cancel' && window.confirm('Cancel this MCP call?')) await send(`/mcp-calls/${row.id}/cancel`, 'POST')
      else if (kind === 'circuits') await send(`/routing/circuits/${row.id}/reset`, 'POST')
      else if (kind === 'routing' && window.confirm('End this routing session?')) await send(`/routing/sessions/${row.id}`, 'DELETE')
      else if (kind === 'deployments') {
        if (!window.confirm(`${humanize(action)} this deployment?`)) return
        await send(`/asset-deployments/${row.id}/${action}`, 'POST', { confirmed: true })
      }
      else if (kind === 'roots') await send(`/asset-roots/${row.id}/scan`, 'POST')
      else if (kind === 'mcp' && action === 'probe') await send(`/mcp/${row.id}/probe`, 'POST')
      else if (kind === 'mcp' && action === 'delete' && window.confirm('Remove this MCP connection?')) await send(`/mcp/${row.id}`, 'DELETE')
      else if (kind === 'assets') {
        if (!window.confirm('Save an asset snapshot?')) return
        await send(`/assets/${row.id}/snapshot`, 'POST', { confirmed: true })
      }
      else if (kind === 'jobs') {
        if (action === 'retry' && !window.confirm('Retry this job?')) return
        await send(`/jobs/${row.id}/${action}`, 'POST', action === 'retry' ? { confirmed: true } : undefined)
      }
      else if (kind === 'runs') {
        if (action === 'stop' && !window.confirm('Stop this agent run?')) return
        await send(`/runs/${row.id}/${action}`, 'POST', action === 'resume' ? {} : undefined)
      }
      else if (kind === 'sessions') {
        if (action === 'star' || action === 'unstar') await send(`/sessions/${row.id}`, 'PATCH', { starred: action === 'star' })
        else if (action === 'forget' && window.confirm('Forget this indexed session?')) await send(`/sessions/${row.id}`, 'DELETE')
      } else if (activeTab === 'providers') await send(`/providers/${row.id}/probe`, 'POST')
      else if (action === 'delete' && ['providers', 'routes', 'clients'].includes(kind) && window.confirm(`Delete this ${humanize(kind).toLowerCase()} record?`)) await send(`/${kind}/${row.id}`, 'DELETE')
      else if (kind === 'registry') await send('/registry/scan', 'POST')
      resource.refresh()
      if (action === 'accept') notify('Approval accepted')
      else if (action === 'deny') notify('Approval denied')
      else notify(`${humanize(action)} submitted`)
    } catch (reason) { setError(readableError(reason)) }
  }
  const pageAction = async () => {
    try {
      if (page === 'registry' && !activeTab) await send('/registry/scan', 'POST')
      else if (page === 'jobs') resource.refresh()
      else if (activeTab === 'assets') await send('/registry/scan', 'POST')
      else if (activeTab === 'providers') setSelected({ __create: 'provider' })
      else if (activeTab === 'routes') setSelected({ __create: 'route' })
      else if (activeTab === 'clients') setSelected({ __create: 'client' })
      else if (activeTab === 'preferences') setSelected({ __create: 'preference' })
      else if (activeTab === 'roots') setSelected({ __create: 'root' })
      else if (activeTab === 'mcp') setSelected({ __create: 'mcp' })
      else if (page === 'registry') await send('/registry/scan', 'POST')
      else setSelected({ __create: 'item' })
      resource.refresh()
    } catch (reason) { setError(readableError(reason)) }
  }
  return <PageFrame page={page} actions={<><Button onClick={resource.refresh}><RefreshCw size={14} />Refresh</Button>{page === 'registry' && <a className="button" href="/api/inventory" download="personal-gateway-inventory.json"><Download size={13} />Export</a>}{page === 'registry' && activeTab === 'assets' ? <Button primary onClick={async () => { try { await send('/registry/scan', 'POST'); notify('Registry scan queued'); } catch (reason) { setError(readableError(reason)) } }}><Search size={14} />Scan</Button> : null}{addable ? <Button primary onClick={pageAction}><Plus size={14} />Add</Button> : null}</>}>
    {tabSets[page] ? <div className="tabs-bar">{tabSets[page].map(([id, label]) => <button className={activeTab === id ? 'active' : ''} key={id} onClick={() => { onTab(id); setOffset(0); setSelected(null) }}>{label}<span>{id === activeTab ? rows.length : ''}</span></button>)}</div> : null}
    {error ? <ErrorPanel error={error} /> : resource.error ? <ErrorPanel error={resource.error} onRetry={resource.refresh} /> : null}
    <div className={`data-workspace ${selected ? 'with-detail' : ''}`}>
      <Panel className="data-panel" title={activeTab ? humanize(activeTab) : title} count={resource.loading ? '…' : resource.data?.total ?? rows.length} loading={resource.loading}>
        <div className="table-with-pagination"><DataTable rows={rows} columns={columns} onSelect={setSelected} selected={selected} empty={`No ${humanize(activeTab || page).toLowerCase()} found.`} actionsFor={(row) => <RowActions tab={activeTab || page} row={row} onAction={doAction} />} />{pageable && <Pagination offset={offset} limit={pageSize} total={resource.data?.total ?? rows.length} next={resource.data?.next} onPage={setOffset} />}</div>
      </Panel>
      {selected && <DetailPanel row={selected} tab={activeTab || page} onClose={() => setSelected(null)} onAction={doAction} onSaved={(result) => { if (result?.__edit) setSelected(result); else { setSelected(null); resource.refresh() } }} onError={setError} />}
    </div>
  </PageFrame>
}

function TrafficPage({ query, refreshKey, notify }) {
  const [status, setStatus] = useState('')
  const [offset, setOffset] = useState(0)
  const pageSize = 60
  useEffect(() => setOffset(0), [query, status])
  const resource = useResource(`/traffic?limit=${pageSize}&offset=${offset}${status ? `&status=${status}` : ''}${query ? `&query=${encodeURIComponent(query)}` : ''}`, refreshKey)
  const [selected, setSelected] = useState(null)
  const rows = records(resource.data)
  const requestedId = new URLSearchParams(location.search).get('request')
  useEffect(() => {
    if (requestedId && !selected) setSelected({ id: requestedId })
  }, [requestedId, selected])
  const closeDetail = () => {
    setSelected(null)
    if (requestedId) history.replaceState(null, '', '/app/traffic')
  }
  return <PageFrame page="traffic" actions={<><select className="toolbar-select" aria-label="Filter request status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option>{['running', 'completed', 'failed', 'cancelled'].map((value) => <option key={value}>{value}</option>)}</select><Button onClick={resource.refresh}><RefreshCw size={14} />Refresh</Button></>}>
    {resource.error && <ErrorPanel error={resource.error} onRetry={resource.refresh} />}
    <div className={`data-workspace ${selected ? 'with-detail' : ''}`}><Panel className="data-panel" title="Requests" count={resource.data?.total ?? rows.length} loading={resource.loading}><div className="table-with-pagination"><DataTable rows={rows} columns={baseLists.traffic.columns.map((key) => ({ key, label: humanize(key), render: key === 'status' ? (row) => <Status value={row.status} /> : key === 'createdAt' ? (row) => formatDate(row.createdAt) : key === 'latencyMs' ? (row) => row.latencyMs == null ? '—' : `${row.latencyMs} ms` : undefined }))} onSelect={setSelected} selected={selected} empty="No captured requests yet." /><Pagination offset={offset} limit={pageSize} total={resource.data?.total ?? rows.length} next={resource.data?.next} onPage={setOffset} /></div></Panel>{selected && <TrafficDetail row={selected} onClose={closeDetail} onDeleted={() => { closeDetail(); resource.refresh(); notify('Capture deleted') }} />}</div>
  </PageFrame>
}

function TrafficDetail({ row, onClose, onDeleted }) {
  const [stage, setStage] = useState('request')
  const detail = useResource(`/traffic/${encodeURIComponent(row.id)}`)
  const capture = useResource(`/traffic/${encodeURIComponent(row.id)}/capture/${stage}`)
  const [error, setError] = useState('')
  const request = detail.data?.request || row
  return <aside className="detail-panel"><DetailHeading title={request.model || 'Request detail'} subtitle={request.id} onClose={onClose} /><div className="detail-scroll"><div className="detail-metrics"><Metric label="Status" value={request.status} /><Metric label="Latency" value={request.latencyMs == null ? '—' : `${request.latencyMs} ms`} /><Metric label="Cost" value={request.costMicros == null ? '—' : request.costMicros} /></div>{error && <ErrorPanel error={error} />}<div className="detail-toolbar"><span className="mono truncate">{request.providerName || 'Provider'} · {request.clientName || 'Client'}</span><Button danger onClick={async () => { if (!window.confirm('Delete all captured content for this request?')) return; try { await send(`/traffic/${encodeURIComponent(row.id)}/capture`, 'DELETE'); onDeleted() } catch (reason) { setError(readableError(reason)) } }}><Trash2 size={13} />Delete capture</Button></div><div className="stage-tabs">{['request', 'effective', 'upstream', 'response', 'output'].map((value) => <button key={value} className={stage === value ? 'active' : ''} onClick={() => setStage(value)}>{value}</button>)}</div><JsonView value={capture.loading ? { loading: true } : capture.data || { error: 'No captured content for this stage.' }} /><Panel title="Request headers"><JsonView value={request.requestHeaders || {}} /></Panel><Panel title="Attempts"><DataTable rows={records(detail.data?.attempts)} columns={['status', 'upstreamStatus', 'latencyMs', 'error'].map((key) => ({ key, label: humanize(key) }))} empty="No attempts recorded." /></Panel></div></aside>
}

function ObservePage({ query, refreshKey, notify }) {
  const path = `/trajectory/sessions?limit=60${query ? `&query=${encodeURIComponent(query)}` : ''}`
  const resource = useResource(path, refreshKey)
  const [session, setSession] = useState(null)
  const nodes = useResource(session ? `/trajectory/sessions/${encodeURIComponent(session.key)}/nodes?limit=100` : null, refreshKey)
  const snapshots = useResource(session ? `/trajectory/snapshots?key=${encodeURIComponent(session.key)}&limit=40` : null, refreshKey)
  const [node, setNode] = useState(null)
  const [snapshot, setSnapshot] = useState(null)
  const [observeTab, setObserveTab] = useState('nodes')
  const [nodeLoading, setNodeLoading] = useState(false)
  const [nodeError, setNodeError] = useState('')
  const [snapshotBusy, setSnapshotBusy] = useState(false)
  const inspectNode = async (row) => {
    setNodeLoading(true); setNodeError('')
    try {
      const value = await get(`/trajectory/sessions/${encodeURIComponent(session.key)}/node?kind=${encodeURIComponent(String(row.kind))}&id=${encodeURIComponent(String(row.id))}`)
      setNode(value)
    } catch (error) { setNodeError(readableError(error)) }
    finally { setNodeLoading(false) }
  }
  const sessions = records(resource.data)
  return <PageFrame page="observe" actions={<Button onClick={resource.refresh}><RefreshCw size={14} />Refresh</Button>}>
    {resource.error && <ErrorPanel error={resource.error} onRetry={resource.refresh} />}
    <div className="observe-layout"><Panel className="observe-list" title="Trajectory sessions" count={sessions.length} loading={resource.loading}><DataTable rows={sessions} columns={['title', 'kind', 'agent', 'calls', 'events', 'status', 'at'].map((key) => ({ key, label: humanize(key), render: key === 'status' ? (row) => <Status value={row.status} /> : key === 'at' ? (row) => formatDate(row.at) : undefined }))} onSelect={(row) => { setSession(row); setNode(null); setSnapshot(null); setObserveTab('nodes') }} selected={session} empty="No trajectory sessions." /></Panel>{session ? <Panel className="observe-detail" title={session.title || session.key} actions={<Button onClick={() => { setSession(null); setNode(null); setSnapshot(null) }}><ArrowLeft size={13} />Back</Button>} loading={observeTab === 'nodes' ? nodes.loading : snapshots.loading}><div className="observe-key mono">{session.key}</div><div className="observe-tabs"><button className={observeTab === 'nodes' ? 'active' : ''} onClick={() => setObserveTab('nodes')}>Nodes <span>{records(nodes.data).length}</span></button><button className={observeTab === 'snapshots' ? 'active' : ''} onClick={() => setObserveTab('snapshots')}>Snapshots <span>{records(snapshots.data).length}</span></button></div><div className="observe-table">{observeTab === 'nodes' ? <DataTable rows={records(nodes.data)} columns={['title', 'kind', 'status', 'at'].map((key) => ({ key, label: humanize(key), render: key === 'status' ? (row) => <Status value={row.status} /> : key === 'at' ? (row) => formatDate(row.at) : undefined }))} onSelect={inspectNode} empty="No nodes in this session." /> : <DataTable rows={records(snapshots.data)} columns={['label', 'nodeId', 'bytes', 'createdAt', 'expiresAt'].map((key) => ({ key, label: humanize(key), render: key.endsWith('At') ? (row) => formatDate(row[key]) : key === 'bytes' ? (row) => formatBytes(row.bytes) : undefined }))} onSelect={setSnapshot} empty="No context snapshots saved." />}</div></Panel> : <div className="observe-empty"><Eye size={22} /><strong>Choose a trajectory</strong><span>Select a session to follow its recorded nodes.</span></div>}</div>
    {(node || nodeLoading || nodeError) && <Modal title={node?.title || 'Trajectory node'} onClose={() => { setNode(null); setNodeError('') }}><div className="detail-scroll">{nodeLoading ? <Loading /> : nodeError ? <ErrorPanel error={nodeError} /> : <><div className="detail-toolbar"><span className="mono truncate">{node?.kind} · {node?.id}</span><Button primary disabled={!session?.key || !node?.kind || !node?.id || snapshotBusy} onClick={async () => { setSnapshotBusy(true); try { await send('/trajectory/snapshots', 'POST', { key: session.key, kind: node.kind, nodeId: node.id, label: node.title || 'Trajectory snapshot', retentionDays: 7, confirmed: true }); notify('Snapshot creation queued. Track progress in Jobs.') } catch (error) { setNodeError(readableError(error)) } finally { setSnapshotBusy(false) }}}><ArrowDownToLine size={13} />Save snapshot</Button></div><JsonView value={node} /></>}</div></Modal>}
    {snapshot && <SnapshotDetail value={snapshot} snapshots={records(snapshots.data)} onClose={() => setSnapshot(null)} onDeleted={() => { setSnapshot(null); snapshots.refresh() }} />}
  </PageFrame>
}

function SnapshotDetail({ value, snapshots, onClose, onDeleted }) {
  const [stage, setStage] = useState('node')
  const [against, setAgainst] = useState('')
  const [diffMode, setDiffMode] = useState(false)
  const path = `/trajectory/snapshots/${encodeURIComponent(value.id)}/${diffMode ? 'diff' : 'inspect'}?stage=${stage}&format=structured${against ? `&against=${encodeURIComponent(against)}` : ''}`
  const detail = useResource(path)
  const [error, setError] = useState('')
  return <Modal title={value.label || 'Context snapshot'} onClose={onClose}><div className="snapshot-workspace"><div className="toolbar-row"><Field label="Stage"><select value={stage} onChange={(e) => setStage(e.target.value)}>{['node', 'request', 'effective', 'upstream', 'response', 'output'].map((value) => <option key={value}>{value}</option>)}</select></Field><Field label="Compare against"><select value={against} onChange={(e) => { setAgainst(e.target.value); setDiffMode(false) }}><option value="">Select snapshot</option>{snapshots.filter((item) => item.id !== value.id).map((item) => <option key={item.id} value={item.id}>{item.label || item.id}</option>)}</select></Field><Button disabled={!against} onClick={() => { setDiffMode(true); detail.refresh() }}><GitBranch size={13} />Diff</Button><a className="button" href={`/api/trajectory/snapshots/${value.id}/export?stage=${stage}`} download><Download size={13} />Export</a><Button danger onClick={async () => { if (!window.confirm('Delete this saved snapshot?')) return; try { await send(`/trajectory/snapshots/${value.id}`, 'DELETE'); onDeleted() } catch (reason) { setError(readableError(reason)) } }}><Trash2 size={13} />Delete</Button></div>{error && <ErrorPanel error={error} />}{detail.error && <ErrorPanel error={detail.error} />}{detail.loading ? <Loading /> : <div className="snapshot-result"><JsonView value={detail.data} /></div>}</div></Modal>
}

function SessionsPage({ query, refreshKey, notify }) {
  const [offset, setOffset] = useState(0)
  const pageSize = 60
  useEffect(() => setOffset(0), [query])
  const resource = useResource(`/sessions?paged=true&limit=${pageSize}&offset=${offset}${query ? `&query=${encodeURIComponent(query)}` : ''}`, refreshKey)
  const sources = useResource('/sources', refreshKey)
  const [selected, setSelected] = useState(null)
  const [view, setView] = useState('sessions')
  const [sourceForm, setSourceForm] = useState(undefined)
  const rows = records(resource.data).filter((row) => matches(row, query))
  return <PageFrame page="sessions" actions={<><Button onClick={() => { resource.refresh(); sources.refresh() }}><RefreshCw size={14} />Refresh</Button>{view === 'sources' ? <Button onClick={() => setSourceForm({})}><Plus size={14} />Add source</Button> : <Button primary onClick={async () => { try { await Promise.all(records(sources.data).filter((source) => source.enabled).map((source) => send(`/sources/${source.id}/scan`, 'POST'))); notify('Enabled sources queued for scanning'); } catch (error) { window.alert(readableError(error)) } }}><Search size={14} />Scan sources</Button>}</>}>
    <div className="tabs-bar"><button className={view === 'sessions' ? 'active' : ''} onClick={() => { setView('sessions'); setSelected(null) }}>Sessions<span>{records(resource.data).length}</span></button><button className={view === 'sources' ? 'active' : ''} onClick={() => { setView('sources'); setSelected(null) }}>Sources<span>{records(sources.data).length}</span></button></div>
    {resource.error && view === 'sessions' && <ErrorPanel error={resource.error} onRetry={resource.refresh} />}{sources.error && view === 'sources' && <ErrorPanel error={sources.error} onRetry={sources.refresh} />}
    {view === 'sources' ? <SourceManager sources={sources} query={query} onEdit={setSourceForm} notify={notify} /> : <div className={`data-workspace ${selected ? 'with-detail' : ''}`}><Panel className="data-panel" title="Indexed sessions" count={resource.data?.total ?? rows.length} loading={resource.loading}><div className="table-with-pagination"><DataTable rows={rows} columns={baseLists.sessions.columns.map((key) => ({ key, label: humanize(key), render: key === 'lastActiveAt' ? (row) => formatDate(row.lastActiveAt) : key === 'status' ? (row) => <Status value={row.status} /> : undefined }))} onSelect={setSelected} selected={selected} empty="No indexed sessions." /><Pagination offset={offset} limit={pageSize} total={resource.data?.total ?? rows.length} next={resource.data?.next} onPage={setOffset} /></div></Panel>{selected && <SessionDetail row={selected} onClose={() => setSelected(null)} onSaved={() => resource.refresh()} />}</div>}
    {sourceForm !== undefined && <SourceEditor value={sourceForm} onClose={() => setSourceForm(undefined)} onSaved={() => { setSourceForm(undefined); sources.refresh(); notify(sourceForm.id ? 'Source updated' : 'Source added') }} />}
  </PageFrame>
}

function SourceManager({ sources, query, onEdit, notify }) {
  const rows = records(sources.data).filter((row) => matches(row, query))
  const action = async (kind, row) => {
    try {
      if (kind === 'scan') await send(`/sources/${row.id}/scan`, 'POST')
      if (kind === 'restore' && window.confirm(`Restore source “${row.name}”?`)) await send(`/sources/${row.id}/restore-deleted`, 'POST')
      if (kind === 'delete') {
        if (!window.confirm(`Remove source “${row.name}”?`)) return
        await send(`/sources/${row.id}`, 'DELETE')
      }
      sources.refresh()
      notify(kind === 'scan' ? 'Source scan queued' : `Source ${kind} complete`)
    } catch (error) { window.alert(readableError(error)) }
  }
  return <Panel title="Session sources" count={rows.length} loading={sources.loading}><DataTable rows={rows} columns={['name', 'agent', 'path', 'enabled', 'captureBodies', 'learn'].map((key) => ({ key, label: humanize(key), render: key === 'enabled' || key === 'captureBodies' || key === 'learn' ? (row) => <Status value={row[key] ? 'enabled' : 'disabled'} /> : undefined }))} empty="Add a local agent session folder to start indexing." actionsFor={(row) => <div className="row-actions"><button className="row-action" onClick={() => onEdit(row)}><Settings2 size={13} /><span>Edit</span></button><button className="row-action" onClick={() => action('scan', row)}><Search size={13} /><span>Scan</span></button><button className="row-action" onClick={() => action('restore', row)}><RotateCcw size={13} /><span>Restore</span></button><button className="row-action danger" onClick={() => action('delete', row)}><Trash2 size={13} /><span>Remove</span></button></div>} /></Panel>
}

function SourceEditor({ value, onClose, onSaved }) {
  const [form, setForm] = useState({ name: value.name || '', agent: value.agent || 'auto', path: value.path || '', enabled: value.enabled ?? true, captureBodies: value.captureBodies ?? false, learn: value.learn ?? false })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return <Modal title={value.id ? 'Edit session source' : 'Add session source'} onClose={onClose}><form className="form-grid" onSubmit={async (event) => { event.preventDefault(); setBusy(true); setError(''); try { await send(value.id ? `/sources/${value.id}` : '/sources', value.id ? 'PATCH' : 'POST', { ...form, ...(value.revision ? { revision: value.revision } : {}) }); onSaved() } catch (reason) { setError(readableError(reason)) } finally { setBusy(false) } }}><Field label="Name"><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field><Field label="Agent"><select value={form.agent} onChange={(e) => setForm({ ...form, agent: e.target.value })}>{['auto', 'claude', 'codex', 'pi'].map((agent) => <option key={agent}>{agent}</option>)}</select></Field><Field label="Session directory"><input required value={form.path} onChange={(e) => setForm({ ...form, path: e.target.value })} placeholder="/Users/name/.codex/sessions" /></Field><SettingRow label="Enabled" value={form.enabled} onChange={(enabled) => setForm({ ...form, enabled })} /><SettingRow label="Capture request bodies" value={form.captureBodies} onChange={(captureBodies) => setForm({ ...form, captureBodies })} /><SettingRow label="Learn preferences from sessions" value={form.learn} onChange={(learn) => setForm({ ...form, learn })} />{error && <ErrorPanel error={error} />}<div className="form-actions"><Button onClick={onClose}>Cancel</Button><Button primary type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save source'}</Button></div></form></Modal>
}

function SessionDetail({ row, onClose, onSaved }) {
  const detail = useResource(`/sessions/${encodeURIComponent(row.id)}?limit=200&order=asc`)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <aside className="detail-panel"><DetailHeading title={row.title || 'Session'} subtitle={`${row.agent || 'Agent'} · ${row.project || 'Local project'}`} onClose={onClose} /><div className="detail-scroll"><div className="detail-toolbar"><Button onClick={async () => { setBusy(true); try { await send(`/sessions/${row.id}`, 'PATCH', { starred: !row.starred }); onSaved() } catch (e) { setError(readableError(e)) } finally { setBusy(false) } }} disabled={busy}><Star size={13} />{row.starred ? 'Unstar' : 'Star'}</Button><a className="button" href={`/api/sessions/${encodeURIComponent(row.id)}/export?limit=200`} download><Download size={13} />Export</a><Button danger onClick={async () => { if (!window.confirm('Forget this indexed session?')) return; try { await send(`/sessions/${row.id}`, 'DELETE'); onSaved(); onClose() } catch (e) { setError(readableError(e)) } }}><Trash2 size={13} />Forget</Button></div>{error && <ErrorPanel error={error} />}{detail.loading ? <Loading /> : detail.error ? <ErrorPanel error={detail.error} /> : <><div className="detail-metrics"><Metric label="Messages" value={detail.data?.session?.messageCount ?? row.messageCount ?? 0} /><Metric label="Status" value={row.status} /><Metric label="Updated" value={formatDate(row.lastActiveAt)} /></div><Panel title="Timeline"><DataTable rows={records(detail.data?.events)} columns={['timestamp', 'role', 'text'].map((key) => ({ key, label: humanize(key) }))} empty="No session events." /></Panel></>}</div></aside>
}

function PersonaPage({ query, refreshKey, notify }) {
  const prefs = useResource('/preferences', refreshKey)
  const timeline = useResource('/preferences/timeline', refreshKey)
  const [selected, setSelected] = useState(null)
  const rows = records(prefs.data).filter((row) => matches(row, query))
  return <PageFrame page="persona" actions={<><Button onClick={prefs.refresh}><RefreshCw size={14} />Refresh</Button><Button primary onClick={() => setSelected({ __create: 'preference' })}><Plus size={14} />Add preference</Button></>}>
    {prefs.error && <ErrorPanel error={prefs.error} onRetry={prefs.refresh} />}
    <div className="overview-grid"><Panel title="Preferences" count={rows.length} loading={prefs.loading}><DataTable rows={rows} columns={baseLists.preferences.columns.map((key) => ({ key, label: humanize(key), render: key === 'status' ? (row) => <Status value={row.status} /> : key === 'updatedAt' ? (row) => formatDate(row.updatedAt) : undefined }))} onSelect={setSelected} selected={selected} empty="No preferences created yet." actionsFor={(row) => <div className="row-actions"><button className="row-action" onClick={() => setSelected({ ...row, __edit: 'preference' })}><Settings2 size={13} /><span>Edit</span></button><button className="row-action danger" onClick={async () => { if (!window.confirm('Delete this preference?')) return; try { await send(`/preferences/${row.id}`, 'DELETE'); prefs.refresh(); timeline.refresh() } catch (error) { window.alert(readableError(error)) } }}><Trash2 size={13} /><span>Delete</span></button></div>} /></Panel><Panel title="Preference timeline" count={records(timeline.data?.revisions).length} loading={timeline.loading}><DataTable rows={records(timeline.data?.revisions)} columns={['preferenceId', 'revision', 'reason', 'createdAt'].map((key) => ({ key, label: humanize(key), render: key === 'createdAt' ? (row) => formatDate(row.createdAt) : undefined }))} empty="No preference history." /></Panel></div>
    {selected?.__edit || selected?.__create ? <PreferenceEditor value={selected} onClose={() => selected.__create ? setSelected(null) : setSelected({ id: selected.id, title: selected.title, content: selected.content, scope: selected.scope, project: selected.project, status: selected.status })} onSaved={() => { setSelected(null); prefs.refresh(); timeline.refresh(); notify('Preference saved') }} /> : selected ? <PreferenceDetail row={selected} onClose={() => setSelected(null)} onEdit={() => setSelected({ ...selected, __edit: 'preference' })} onRestore={() => { prefs.refresh(); timeline.refresh() }} /> : null}
  </PageFrame>
}

function PreferenceDetail({ row, onClose, onEdit, onRestore }) {
  const history = useResource(`/preferences/${encodeURIComponent(row.id)}/history`)
  const [error, setError] = useState('')
  return <aside className="detail-panel"><DetailHeading title={row.title} subtitle={`${row.scope}${row.project ? ` · ${row.project}` : ''}`} onClose={onClose} /><div className="detail-scroll"><div className="detail-toolbar"><Button onClick={onEdit}><Settings2 size={13} />Edit</Button><Status value={row.status} /></div><Panel title="Preference"><p className="preference-content">{row.content}</p></Panel>{error && <ErrorPanel error={error} />}<Panel title="Revision history" loading={history.loading}><DataTable rows={records(history.data)} columns={['revision', 'status', 'createdAt'].map((key) => ({ key, label: humanize(key), render: key === 'createdAt' ? (item) => formatDate(item.createdAt) : undefined }))} empty="No previous revisions." actionsFor={(item) => <button className="row-action" onClick={async () => { try { await send(`/preferences/${row.id}/restore`, 'POST', { revision: item.revision }); onRestore() } catch (reason) { setError(readableError(reason)) } }}>Restore</button>} /></Panel></div></aside>
}

function PreferenceEditor({ value, onClose, onSaved }) {
  const [form, setForm] = useState({ title: value.title || '', content: value.content || '', scope: value.scope || 'global', project: value.project || '', status: value.status || 'candidate' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <Modal title={value.__create ? 'Add preference' : 'Edit preference'} onClose={onClose}><form className="form-grid" onSubmit={async (event) => { event.preventDefault(); setBusy(true); setError(''); try { await send(value.id ? `/preferences/${value.id}` : '/preferences', value.id ? 'PATCH' : 'POST', { ...form, project: form.project || null }); onSaved() } catch (reason) { setError(readableError(reason)) } finally { setBusy(false) } }}><Field label="Title"><input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field><Field label="Scope"><select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })}><option value="global">Global</option><option value="project">Project</option></select></Field>{form.scope === 'project' && <Field label="Project"><input required value={form.project} onChange={(e) => setForm({ ...form, project: e.target.value })} /></Field>}<Field label="Status"><select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}><option value="candidate">Candidate</option><option value="active">Active</option><option value="paused">Paused</option></select></Field><Field label="Preference"><textarea rows={5} required value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} /></Field>{error && <ErrorPanel error={error} />}<div className="form-actions"><Button onClick={onClose}>Cancel</Button><Button primary type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save preference'}</Button></div></form></Modal>
}

function RunsPage({ query, refreshKey, notify }) {
  const routes = useResource('/routes')
  const runs = useResource('/runs', refreshKey)
  const [createOpen, setCreateOpen] = useState(false)
  const [selected, setSelected] = useState(null)
  const rows = records(runs.data).filter((row) => matches(row, query))
  return <PageFrame page="runs" actions={<><Button onClick={runs.refresh}><RefreshCw size={14} />Refresh</Button><Button primary onClick={() => setCreateOpen(true)}><Plus size={14} />Start run</Button></>}>
    {runs.error && <ErrorPanel error={runs.error} onRetry={runs.refresh} />}
    <div className={`data-workspace ${selected ? 'with-detail' : ''}`}><Panel className="data-panel" title="Agent runs" count={runs.data?.length ?? rows.length} loading={runs.loading}><DataTable rows={rows} columns={baseLists.runs.columns.map((key) => ({ key, label: humanize(key), render: key === 'status' ? (row) => <Status value={row.status} /> : key === 'updatedAt' ? (row) => formatDate(row.updatedAt) : undefined }))} onSelect={setSelected} selected={selected} empty="No agent runs yet." actionsFor={(row) => <RowActions tab="runs" row={row} onAction={async (action) => { try { await send(`/runs/${row.id}/${action}`, 'POST', action === 'resume' ? {} : undefined); runs.refresh(); notify(`${humanize(action)} submitted`) } catch (error) { window.alert(readableError(error)) } }} />} /></Panel>{selected && <RunDetail row={selected} onClose={() => setSelected(null)} onAction={async (action, row) => { try { await send(`/runs/${row.id}/${action}`, 'POST', action === 'resume' ? {} : undefined); runs.refresh(); notify(`${humanize(action)} submitted`) } catch (error) { window.alert(readableError(error)) } }} />}</div>
    {createOpen && <RunEditor routes={records(routes.data)} error={routes.error} onClose={() => setCreateOpen(false)} onSaved={() => { setCreateOpen(false); runs.refresh(); notify('Agent run started') }} />}
  </PageFrame>
}

function RunEditor({ routes, error: routeError, onClose, onSaved }) {
  const [form, setForm] = useState({ agent: 'codex', goal: '', workspace: '', routeId: routes[0]?.id || '', timeoutSeconds: 600 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(routeError || '')
  return <Modal title="Start agent run" onClose={onClose}><form className="form-grid" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(''); try { await send('/runs', 'POST', { ...form, timeoutSeconds: Number(form.timeoutSeconds) }); onSaved() } catch (reason) { setError(readableError(reason)) } finally { setBusy(false) } }}><Field label="Agent"><select value={form.agent} onChange={(e) => setForm({ ...form, agent: e.target.value })}><option>codex</option><option>claude</option><option>pi</option></select></Field><Field label="Model route"><select required value={form.routeId} onChange={(e) => setForm({ ...form, routeId: e.target.value })}><option value="">Choose a route</option>{routes.map((route) => <option key={route.id} value={route.id}>{route.alias}</option>)}</select></Field><Field label="Workspace path"><input required value={form.workspace} onChange={(e) => setForm({ ...form, workspace: e.target.value })} placeholder="/path/to/workspace" /></Field><Field label="Goal"><textarea required rows={5} value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })} /></Field>{error && <ErrorPanel error={error} />}{routes.length === 0 && <p className="muted">Create and enable a model route before starting a run.</p>}<div className="form-actions"><Button onClick={onClose}>Cancel</Button><Button primary type="submit" disabled={busy || routes.length === 0}>{busy ? 'Starting…' : 'Start run'}</Button></div></form></Modal>
}

function PlaygroundPage({ notify }) {
  const routes = useResource('/routes')
  const [form, setForm] = useState({ routeId: '', protocol: 'responses', prompt: '', project: '' })
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { if (!form.routeId && routes.data?.length) setForm((current) => ({ ...current, routeId: routes.data[0].id, protocol: routes.data[0].protocol || 'responses' })) }, [form.routeId, routes.data])
  return <PageFrame page="playground" actions={<Button onClick={() => { setResult(null); setError('') }}><RotateCcw size={14} />Reset</Button>}>
    <div className="playground-layout"><Panel title="Request configuration"><form className="form-grid" onSubmit={async (event) => { event.preventDefault(); setBusy(true); setError(''); setResult(null); try { const response = await send('/debug/model', 'POST', { routeId: form.routeId, protocol: form.protocol, project: form.project || null, personalize: true, body: { model: routes.data?.find((route) => route.id === form.routeId)?.alias, input: form.prompt } }); setResult(response); notify('Debug request queued') } catch (reason) { setError(readableError(reason)) } finally { setBusy(false) } }}><Field label="Model route"><select required value={form.routeId} onChange={(e) => { const route = records(routes.data).find((item) => item.id === e.target.value); setForm({ ...form, routeId: e.target.value, protocol: route?.protocol || 'responses' }) }}><option value="">Select a route</option>{records(routes.data).map((route) => <option key={route.id} value={route.id}>{route.alias} · {route.protocol}</option>)}</select></Field><Field label="Protocol"><select value={form.protocol} onChange={(e) => setForm({ ...form, protocol: e.target.value })}>{['responses', 'chat', 'messages', 'gemini', 'systemone'].map((protocol) => <option key={protocol}>{protocol}</option>)}</select></Field><Field label="Project (optional)"><input value={form.project} onChange={(e) => setForm({ ...form, project: e.target.value })} /></Field><Field label="Prompt"><textarea className="prompt-editor mono" required rows={10} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} placeholder="Write a prompt to send through this route…" /></Field>{error && <ErrorPanel error={error} />}{routes.error && <ErrorPanel error={routes.error} />}{records(routes.data).length === 0 && <p className="muted">Configure an enabled route in Models first.</p>}<div className="form-actions"><Button primary type="submit" disabled={busy || !form.routeId}>{busy ? 'Queueing…' : 'Send request'}<ArrowUpRight size={14} /></Button></div></form></Panel><Panel title="Result"><div className="result-content">{result ? <><div className="result-status"><Clock3 size={16} /><strong>Debug job queued</strong><span className="mono">{result.job?.id || 'Job accepted'}</span></div><p>Track the request, attempts, and response in Jobs.</p></> : <div className="result-empty"><TerminalSquare size={22} /><strong>Response appears here</strong><span>Submit a prompt to inspect the actual upstream result.</span></div>}</div></Panel></div>
  </PageFrame>
}

function SettingsPage({ notify }) {
  const settings = useResource('/settings')
  const observability = useResource('/observability')
  const storage = useResource('/storage/usage')
  const value = settings.data || {}
  const [error, setError] = useState('')
  const [purgeCategory, setPurgeCategory] = useState('captures')
  const update = async (patch) => { setError(''); try { const result = await send('/settings', 'PATCH', patch); settings.setData({ ...value, ...result }); notify('Settings saved') } catch (reason) { setError(readableError(reason)) } }
  return <PageFrame page="settings" actions={<Button onClick={() => { settings.refresh(); observability.refresh(); storage.refresh() }}><RefreshCw size={14} />Refresh</Button>}>
    {(settings.error || error) && <ErrorPanel error={error || settings.error} />}
    <div className="overview-grid"><div className="settings-stack"><Panel title="Workspace privacy" loading={settings.loading}><SettingRow label="Personalization" detail="Apply active preferences to gateway requests." value={value.personalization} onChange={(checked) => update({ personalization: checked })} /><SettingRow label="Adaptive context" value={value.adaptiveContext?.enabled} onChange={(enabled) => update({ adaptiveContext: { ...value.adaptiveContext, enabled } })} /></Panel><ObservabilitySettings value={observability.data || {}} loading={observability.loading} error={observability.error} onSave={async (next) => { try { const result = await send('/observability', 'PATCH', next); observability.setData(result); notify('Capture settings saved') } catch (reason) { setError(readableError(reason)) } }} onDelete={async () => { if (!window.confirm('Delete all captured request content? This cannot be undone.')) return; try { await send('/observability/captures', 'DELETE'); notify('Captured content deleted'); storage.refresh(); observability.refresh() } catch (reason) { setError(readableError(reason)) } }} /><Panel title="Request behavior"><SettingRow label="Protocol conversion" value={value.protocolConversion} onChange={(checked) => update({ protocolConversion: checked })} /><SettingRow label="Discard reasoning blocks" value={value.discardReasoning} onChange={(checked) => update({ discardReasoning: checked })} /><SettingRow label="Ignore hosted tools" value={value.ignoreHostedTools} onChange={(checked) => update({ ignoreHostedTools: checked })} /><SettingRow label="Transparent retry" value={value.transparentRetry?.enabled} onChange={(enabled) => update({ transparentRetry: { ...value.transparentRetry, enabled } })} /></Panel></div><Panel title="Local storage" loading={storage.loading}><div className="storage-total"><Database size={18} /><div><strong>{formatBytes(storage.data?.totalBytes || storage.data?.usedBytes)}</strong><span>Used by gateway data</span></div></div>{records(storage.data?.categories || storage.data?.items).map((item) => <div className="storage-row" key={item.id || item.name || item.category}><span>{humanize(item.id || item.name || item.category)}</span><strong>{formatBytes(item.bytes || item.sizeBytes)}</strong></div>)}{storage.error && <ErrorPanel error={storage.error} />}<div className="storage-purge"><Field label="Purge category"><select value={purgeCategory} onChange={(event) => setPurgeCategory(event.target.value)}>{['sessions', 'captures', 'snapshots', 'jobs', 'runs', 'assets', 'mcp', 'traffic', 'audit', 'transient'].map((category) => <option key={category}>{category}</option>)}</select></Field><Button danger onClick={async () => { if (!window.confirm(`Permanently purge ${purgeCategory}?`)) return; try { await send('/storage/purge', 'POST', { categories: [purgeCategory] }); notify(`${humanize(purgeCategory)} purged`); storage.refresh() } catch (reason) { setError(readableError(reason)) } }}><Trash2 size={13} />Purge</Button></div></Panel></div>
  </PageFrame>
}

function ObservabilitySettings({ value, loading, error, onSave, onDelete }) {
  const [form, setForm] = useState({ enabled: value.enabled ?? true, retentionDays: value.retentionDays ?? 7, maxStageBytes: value.maxStageBytes ?? 4 * 1024 * 1024, maxStorageBytes: value.maxStorageBytes ?? 512 * 1024 * 1024 })
  useEffect(() => setForm({ enabled: value.enabled ?? true, retentionDays: value.retentionDays ?? 7, maxStageBytes: value.maxStageBytes ?? 4 * 1024 * 1024, maxStorageBytes: value.maxStorageBytes ?? 512 * 1024 * 1024 }), [value.enabled, value.retentionDays, value.maxStageBytes, value.maxStorageBytes])
  return <Panel title="Observability capture" loading={loading}><SettingRow label="Capture request stages" detail="Store local request/response evidence for inspection." value={form.enabled} onChange={(enabled) => setForm({ ...form, enabled })} /><div className="form-grid compact-form"><Field label="Retention days"><input type="number" min="1" max="365" value={form.retentionDays} onChange={(event) => setForm({ ...form, retentionDays: Number(event.target.value) })} /></Field><Field label="Max stage bytes"><input type="number" min="65536" max="67108864" value={form.maxStageBytes} onChange={(event) => setForm({ ...form, maxStageBytes: Number(event.target.value) })} /></Field><Field label="Max storage bytes"><input type="number" min="1048576" max="5368709120" value={form.maxStorageBytes} onChange={(event) => setForm({ ...form, maxStorageBytes: Number(event.target.value) })} /></Field></div>{error && <ErrorPanel error={error} />}<div className="setting-actions"><Button primary onClick={() => onSave({ ...form })}>Save capture settings</Button><Button danger onClick={onDelete}><Trash2 size={13} />Delete captures</Button></div></Panel>
}

function SettingRow({ label, detail, value, onChange }) {
  return <div className="setting-row"><div><strong>{label}</strong>{detail && <small>{detail}</small>}</div><button role="switch" aria-label={label} aria-checked={Boolean(value)} className={`switch ${value ? 'on' : ''}`} onClick={() => onChange(!value)}><span /></button></div>
}

function PageFrame({ page, actions, children }) {
  const [title, description] = pageMeta[page] || ['Workspace', '']
  return <div className="page-container"><header className="page-header"><div><div className="section-kicker">LOCAL WORKSPACE</div><h1>{title}</h1><p>{description}</p></div><div className="page-actions">{actions}</div></header><div className="page-body">{children}</div></div>
}

function Panel({ title, count, actions, loading, className = '', children }) {
  return <section className={`panel ${className}`}><header className="panel-header"><div><h2>{title}</h2>{count !== undefined && <span className="panel-count">{count}</span>}</div><div className="panel-actions">{actions}</div></header>{loading && <div className="loading-line"><LoaderCircle size={15} />Loading local data…</div>}<div className="panel-content">{children}</div></section>
}

function DataTable({ rows, columns, onSelect, selected, empty = 'No records yet.', actionsFor }) {
  if (!rows.length) return <div className="empty-state"><div className="empty-icon"><FileJson2 size={18} /></div><strong>{empty}</strong><span>Data appears here when the gateway has recorded it.</span></div>
  return <div className="table-scroll"><table><thead><tr>{columns.map((column) => <th key={column.key}>{column.label}</th>)}{actionsFor && <th className="actions-column">Actions</th>}</tr></thead><tbody>{rows.map((row, index) => <tr key={row.id || row.key || index} className={selected && (selected.id || selected.key) === (row.id || row.key) ? 'selected' : ''} onClick={() => onSelect?.(row)}>{columns.map((column) => <td key={column.key} title={formatValue(row[column.key])}>{column.render ? column.render(row) : formatValue(row[column.key])}</td>)}{actionsFor && <td className="actions-column" onClick={(event) => event.stopPropagation()}>{actionsFor(row)}</td>}</tr>)}</tbody></table></div>
}

function RowActions({ tab, row, onAction }) {
  const button = (action, label, Icon, danger = false) => <button title={label} className={`row-action ${danger ? 'danger' : ''}`} onClick={() => onAction(action, row)}><Icon size={13} /><span>{label}</span></button>
  if (tab === 'approvals') return <div className="row-actions">{button('accept', 'Approve', Check)}{button('deny', 'Deny', X, true)}</div>
  if (tab === 'mcp-calls' && row.status === 'pending') return <div className="row-actions">{button('accept', 'Allow', Check)}{button('deny', 'Deny', X, true)}</div>
  if (tab === 'circuits') return <div className="row-actions">{button('reset', 'Reset', RotateCcw)}</div>
  if (tab === 'routing') return <div className="row-actions">{button('delete', 'End', X, true)}</div>
  if (tab === 'deployments') return <div className="row-actions">{button('apply', 'Apply', Check)}{button('restore', 'Restore', RotateCcw)}</div>
  if (tab === 'roots') return <div className="row-actions">{button('scan', 'Scan', Search)}</div>
  if (tab === 'assets') return <div className="row-actions">{button('snapshot', 'Snapshot', ArrowDownToLine)}</div>
  if (tab === 'jobs') return <div className="row-actions">{['queued', 'running', 'waiting'].includes(row.status) ? button('cancel', 'Cancel', X) : button('retry', 'Retry', RotateCcw)}</div>
  if (tab === 'runs') return <div className="row-actions">{['running', 'queued'].includes(row.status) ? <>{button('pause', 'Pause', X)}{button('stop', 'Stop', X, true)}</> : button('resume', 'Resume', PlayIcon)}</div>
  if (tab === 'sessions') return <div className="row-actions">{button(row.starred ? 'unstar' : 'star', row.starred ? 'Unstar' : 'Star', Star)}{button('forget', 'Forget', Trash2, true)}</div>
  if (tab === 'providers') return <div className="row-actions">{button('probe', 'Probe', ActivityIcon)}</div>
  if (tab === 'mcp') return <div className="row-actions">{button('probe', 'Probe', ActivityIcon)}{button('delete', 'Remove', Trash2, true)}</div>
  if (['routes', 'clients'].includes(tab)) return <div className="row-actions">{button('delete', tab === 'clients' ? 'Revoke' : 'Delete', Trash2, true)}</div>
  if (tab === 'mcp-calls' && ['running', 'pending'].includes(row.status)) return <div className="row-actions">{button('cancel', 'Cancel', X)}</div>
  return null
}

function DetailPanel({ row, tab, onClose, onAction, onSaved, onError }) {
  if (row.__create) return <ResourceEditor type={row.__create} value={row.id ? row : undefined} onClose={onClose} onSaved={onSaved} onError={onError} />
  if (row.__edit) return <ResourceEditor type={row.__edit} value={row} onClose={onClose} onSaved={onSaved} onError={onError} />
  if (tab === 'jobs') return <JobDetail row={row} onClose={onClose} onAction={onAction} />
  if (tab === 'runs') return <RunDetail row={row} onClose={onClose} onAction={onAction} />
  if (tab === 'mcp') return <McpDetail row={row} onClose={onClose} onAction={onAction} />
  return <aside className="detail-panel"><DetailHeading title={row.name || row.alias || row.title || row.label || row.model || humanize(tab)} subtitle={row.id || row.key || ''} onClose={onClose} /><div className="detail-scroll"><div className="detail-toolbar">{tab === 'providers' && <Button onClick={() => onAction('probe', row)}><ActivityIcon size={13} />Probe</Button>}{['providers', 'routes'].includes(tab) && <Button onClick={() => onSaved({ __edit: tab, ...row })}><Settings2 size={13} />Edit</Button>}{['providers', 'routes', 'clients'].includes(tab) && <RowActions tab={tab} row={row} onAction={onAction} />}{tab === 'mcp' && <><Button onClick={() => onAction('probe', row)}><ActivityIcon size={13} />Probe</Button><Button danger onClick={() => onAction('delete', row)}><Trash2 size={13} />Remove</Button></>}{['jobs', 'runs', 'sessions'].includes(tab) && <RowActions tab={tab} row={row} onAction={onAction} />}</div><div className="detail-metrics">{detailMetrics(row).map(([key, value]) => <Metric key={key} label={humanize(key)} value={key.toLowerCase().endsWith('at') ? formatDate(value) : formatValue(value)} />)}</div><Panel title="Record details"><JsonView value={row} /></Panel></div></aside>
}

function McpDetail({ row, onClose, onAction }) {
  const history = useResource(`/mcp/${encodeURIComponent(row.id)}/history`)
  const [kind, setKind] = useState('call')
  const [name, setName] = useState('')
  const [argumentsText, setArgumentsText] = useState('{}')
  const [error, setError] = useState('')
  const invoke = async () => {
    setError('')
    try {
      if (!window.confirm(`Run this MCP ${kind}?`)) return
      const args = JSON.parse(argumentsText || '{}')
      await send(`/mcp/${encodeURIComponent(row.id)}/${kind}`, 'POST', { name, arguments: args, confirmed: true })
      setName('')
      setArgumentsText('{}')
    } catch (reason) { setError(readableError(reason)) }
  }
  return <aside className="detail-panel"><DetailHeading title={row.name || 'MCP connection'} subtitle={row.id} onClose={onClose} /><div className="detail-scroll"><div className="detail-toolbar"><Status value={row.status} /><Button onClick={() => onAction('probe', row)}><ActivityIcon size={13} />Probe</Button><Button onClick={async () => { try { await send(`/mcp/${encodeURIComponent(row.id)}`, 'PATCH', { enabled: !row.enabled }); onAction('refresh', row) } catch (reason) { setError(readableError(reason)) } }}><Settings2 size={13} />{row.enabled ? 'Disable' : 'Enable'}</Button><Button danger onClick={() => onAction('delete', row)}>Remove</Button></div>{error && <ErrorPanel error={error} />}<Panel title="Debug MCP operation"><div className="form-grid"><Field label="Operation"><select value={kind} onChange={(event) => setKind(event.target.value)}><option value="call">Tool call</option><option value="resource">Resource</option><option value="prompt">Prompt</option></select></Field><Field label="Name"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="tool_or_resource_name" /></Field><Field label="Arguments (JSON)"><textarea rows={4} value={argumentsText} onChange={(event) => setArgumentsText(event.target.value)} /></Field><div className="form-actions"><Button primary disabled={!name.trim()} onClick={invoke}>Run operation</Button></div></div></Panel><Panel title="Connection history" loading={history.loading}><DataTable rows={records(history.data)} columns={['version', 'status', 'createdAt'].map((key) => ({ key, label: humanize(key), render: key === 'createdAt' ? (item) => formatDate(item.createdAt) : undefined }))} empty="No MCP revisions recorded." /></Panel><Panel title="Connection details"><JsonView value={row} /></Panel></div></aside>
}

function JobDetail({ row, onClose, onAction }) {
  const detail = useResource(`/jobs/${encodeURIComponent(row.id)}`)
  const attempts = useResource(`/jobs/${encodeURIComponent(row.id)}/attempts`)
  const data = detail.data || row
  return <aside className="detail-panel"><DetailHeading title={data.label || 'Background job'} subtitle={data.id} onClose={onClose} /><div className="detail-scroll"><div className="detail-toolbar"><Status value={data.status} /><RowActions tab="jobs" row={data} onAction={onAction} /></div><div className="detail-metrics"><Metric label="Phase" value={data.phase} /><Metric label="Progress" value={data.total ? `${data.processed || 0} / ${data.total}` : data.processed || 0} /><Metric label="Attempts" value={data.attempts} /></div>{detail.error && <ErrorPanel error={detail.error} />}<Panel title="Job details" loading={detail.loading}><JsonView value={data} /></Panel><Panel title="Attempts" count={records(attempts.data).length} loading={attempts.loading}><DataTable rows={records(attempts.data)} columns={['number', 'status', 'httpStatus', 'startedAt', 'endedAt', 'error'].map((key) => ({ key, label: humanize(key), render: key.endsWith('At') ? (item) => formatDate(item[key]) : undefined }))} empty="No attempts recorded." /></Panel></div></aside>
}

function RunDetail({ row, onClose, onAction }) {
  const detail = useResource(`/runs/${encodeURIComponent(row.id)}`)
  const events = useResource(`/runs/${encodeURIComponent(row.id)}/events`)
  const budget = useResource(`/runs/${encodeURIComponent(row.id)}/budget`)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const data = detail.data || row
  const control = async (action, body) => {
    try { await send(`/runs/${row.id}/${action}`, 'POST', body); detail.refresh() }
    catch (reason) { setError(readableError(reason)) }
  }
  return <aside className="detail-panel"><DetailHeading title={data.goal || data.agent || 'Agent run'} subtitle={`${data.agent || 'Agent'} · ${data.id}`} onClose={onClose} /><div className="detail-scroll"><div className="detail-toolbar"><Status value={data.status} />{['running', 'queued'].includes(data.status) ? <><Button onClick={() => control('pause')}><X size={13} />Pause</Button><Button danger onClick={() => { if (window.confirm('Stop this run?')) control('stop') }}><X size={13} />Stop</Button></> : <Button onClick={() => control('resume', {})}><Play size={13} />Resume</Button>}</div><div className="detail-metrics"><Metric label="Turns" value={data.turns} /><Metric label="Workspace" value={data.workspace} /><Metric label="Budget" value={budget.data?.remainingMicros ?? budget.data?.usedMicros} /></div>{error && <ErrorPanel error={error} />}<Panel title="Steer this run"><div className="steer-form"><input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Send a message to the agent…" /><Button primary disabled={!message.trim()} onClick={async () => { await control('steer', { message }); setMessage('') }}>Send</Button></div></Panel><Panel title="Run events" count={records(events.data).length} loading={events.loading}><DataTable rows={records(events.data)} columns={['createdAt', 'kind', 'message', 'status'].map((key) => ({ key, label: humanize(key), render: key === 'createdAt' ? (item) => formatDate(item.createdAt) : undefined }))} empty="No events recorded." /></Panel><Panel title="Run record" loading={detail.loading}><JsonView value={data} /></Panel><RowActions tab="runs" row={data} onAction={(action) => onAction(action, data)} /></div></aside>
}

function ResourceEditor({ type, value, onClose, onSaved, onError }) {
  if (type === 'preference') return <PreferenceEditor value={value || { __create: 'preference' }} onClose={onClose} onSaved={onSaved} />
  return <ResourceForm type={type} value={value} onClose={onClose} onSaved={onSaved} onError={onError} />
}

function ResourceForm({ type, value, onClose, onSaved, onError }) {
  const providers = useResource('/providers')
  const routes = useResource('/routes')
  const [form, setForm] = useState(() => ({
    name: value?.name || '', protocol: value?.protocol || 'openai', baseUrl: value?.baseUrl || '', secret: '',
    alias: value?.alias || '', strategy: value?.strategy || 'priority', providerId: value?.targets?.[0]?.providerId || '', model: value?.targets?.[0]?.model || '',
    project: value?.project || '', personalize: Boolean(value?.personalize), routeIds: value?.routeIds || [],
    agent: value?.agent || 'codex', path: value?.path || '', capture: Boolean(value?.capture),
    transport: value?.transport || 'http', url: value?.url || '', command: '',
  }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (event) => {
    event.preventDefault(); setBusy(true); setError('')
    try {
      let path = '/providers', method = 'POST', body = form
      if (type === 'provider') { path = value ? `/providers/${value.id}` : '/providers'; method = value ? 'PATCH' : 'POST'; body = { name: form.name, protocol: form.protocol, baseUrl: form.baseUrl, enabled: value?.enabled ?? true, ...(form.secret ? { secret: form.secret } : {}) } }
      if (type === 'route') { path = value ? `/routes/${value.id}` : '/routes'; method = value ? 'PATCH' : 'POST'; body = { alias: form.alias, protocol: form.protocol, strategy: form.strategy, enabled: value?.enabled ?? true, targets: [{ providerId: form.providerId, model: form.model, weight: 1, priority: 0 }], contextLimit: value?.contextLimit || 128000, outputLimit: value?.outputLimit || 8192 } }
      if (type === 'client') { path = '/clients'; body = { name: form.name, project: form.project || null, personalize: form.personalize, routeIds: form.routeIds, memoryAccess: false, mcpGrants: [], modelAliases: [], maxConcurrent: 4 } }
      if (type === 'root') { path = '/asset-roots'; body = { name: form.name, agent: form.agent, path: form.path, enabled: true, capture: form.capture, followSymlinks: false, project: null } }
      if (type === 'mcp') { path = '/mcp'; body = { name: form.name, transport: form.transport, url: form.transport === 'http' ? form.url : null, command: form.transport === 'stdio' ? form.command : null, args: [], env: {}, headers: {} } }
      const result = await send(path, method, body)
      if (result?.key) window.alert(`Copy this client key now. It will not be shown again:\n\n${result.key}`)
      onSaved(result)
    } catch (reason) { const message = readableError(reason); setError(message); onError?.(message) } finally { setBusy(false) }
  }
  const title = `${value ? 'Edit' : 'Add'} ${humanize(type)}`
  return <Modal title={title} onClose={onClose}><form className="form-grid" onSubmit={submit}>
    {['provider', 'client', 'root', 'mcp'].includes(type) && <Field label="Name"><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>}
    {type === 'provider' && <><Field label="Protocol"><select value={form.protocol} onChange={(e) => setForm({ ...form, protocol: e.target.value })}>{[['openai', 'OpenAI compatible'], ['anthropic', 'Anthropic'], ['gemini', 'Gemini'], ['typesafe', 'TypeSafe']].map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></Field><Field label="Base URL"><input required type="url" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" /></Field><Field label={value ? 'Replace API key (optional)' : 'API key'}><input type="password" required={!value} autoComplete="new-password" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} /></Field></>}
    {type === 'route' && <><Field label="Route alias"><input required value={form.alias} onChange={(e) => setForm({ ...form, alias: e.target.value })} /></Field><Field label="Protocol"><select value={form.protocol} onChange={(e) => setForm({ ...form, protocol: e.target.value })}>{['responses', 'chat', 'messages', 'gemini', 'systemone'].map((protocol) => <option key={protocol}>{protocol}</option>)}</select></Field><Field label="Provider"><select required value={form.providerId} onChange={(e) => setForm({ ...form, providerId: e.target.value })}><option value="">Select provider</option>{records(providers.data).map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></Field><Field label="Upstream model"><input required value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} /></Field><Field label="Routing strategy"><select value={form.strategy} onChange={(e) => setForm({ ...form, strategy: e.target.value })}>{['priority', 'round_robin', 'least_active'].map((value) => <option key={value}>{value}</option>)}</select></Field></>}
    {type === 'client' && <><Field label="Project (optional)"><input value={form.project} onChange={(e) => setForm({ ...form, project: e.target.value })} /></Field><Field label="Allowed routes"><select multiple value={form.routeIds} onChange={(e) => setForm({ ...form, routeIds: Array.from(e.target.selectedOptions, (option) => option.value) })}>{records(routes.data).map((route) => <option key={route.id} value={route.id}>{route.alias}</option>)}</select></Field><SettingRow label="Personalization" value={form.personalize} onChange={(personalize) => setForm({ ...form, personalize })} /></>}
    {type === 'root' && <><Field label="Agent"><select value={form.agent} onChange={(e) => setForm({ ...form, agent: e.target.value })}>{['claude', 'codex', 'pi', 'shared'].map((agent) => <option key={agent}>{agent}</option>)}</select></Field><Field label="Root path"><input required value={form.path} onChange={(e) => setForm({ ...form, path: e.target.value })} /></Field><SettingRow label="Capture sessions" value={form.capture} onChange={(capture) => setForm({ ...form, capture })} /></>}
    {type === 'mcp' && <><Field label="Transport"><select value={form.transport} onChange={(e) => setForm({ ...form, transport: e.target.value })}><option value="http">HTTP</option><option value="stdio">stdio</option></select></Field>{form.transport === 'http' ? <Field label="Server URL"><input required type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} /></Field> : <Field label="Command"><input required value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} /></Field>}</>}
    {error && <ErrorPanel error={error} />}{providers.error && type === 'route' && <ErrorPanel error={providers.error} />}{routes.error && type === 'client' && <ErrorPanel error={routes.error} />}<div className="form-actions"><Button onClick={onClose}>Cancel</Button><Button primary type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button></div>
  </form></Modal>
}

function DetailHeading({ title, subtitle, onClose }) {
  return <header className="detail-heading"><div><span className="section-kicker">DETAIL</span><h2 title={title}>{title}</h2>{subtitle && <small className="mono truncate">{subtitle}</small>}</div><button className="icon-button" onClick={onClose} aria-label="Close detail"><X size={16} /></button></header>
}

function Metric({ label, value, detail, icon: Icon }) {
  return <div className="metric-card">{Icon && <span className="metric-icon"><Icon size={14} /></span>}<span>{label}</span><strong>{formatValue(value)}</strong>{detail && <small>{detail}</small>}</div>
}

function JsonView({ value }) {
  return <pre className="json-view">{JSON.stringify(value ?? null, null, 2)}</pre>
}

function Status({ value }) {
  const tone = ['completed', 'up', 'healthy', 'active', 'ready', 'approved'].includes(String(value).toLowerCase()) ? 'success' : ['failed', 'down', 'error', 'denied', 'unavailable'].includes(String(value).toLowerCase()) ? 'danger' : ['running', 'pending', 'queued', 'candidate', 'attention', 'waiting'].includes(String(value).toLowerCase()) ? 'warning' : 'neutral'
  return <span className={`status-badge ${tone}`}><i />{formatValue(value)}</span>
}

function Button({ children, primary = false, danger = false, className = '', ...props }) {
  return <button className={`button ${primary ? 'primary' : ''} ${danger ? 'danger' : ''} ${className}`} type={props.type || 'button'} {...props}>{children}</button>
}

function Pagination({ offset, limit, total, next, onPage }) {
  const page = Math.floor(offset / limit) + 1
  const lastPage = Math.max(1, Math.ceil(total / limit))
  return <div className="pagination"><span>{total ? `Page ${page} of ${lastPage} · ${total} records` : 'No records'}</span><div><Button disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - limit))}><ArrowLeft size={12} />Previous</Button><Button disabled={next == null} onClick={() => onPage(next ?? offset + limit)}>Next<ArrowRight size={12} /></Button></div></div>
}

function Field({ label, children }) { return <label className="field"><span>{label}</span>{children}</label> }

function Modal({ title, onClose, children }) {
  useEffect(() => { const onKey = (event) => event.key === 'Escape' && onClose(); addEventListener('keydown', onKey); return () => removeEventListener('keydown', onKey) }, [onClose])
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="form-modal" onMouseDown={(event) => event.stopPropagation()}><header className="modal-header"><div><span className="section-kicker">LOCAL WORKSPACE</span><h2>{title}</h2></div><button className="icon-button" onClick={onClose}><X size={16} /></button></header><div className="modal-content">{children}</div></section></div>
}

function ErrorPanel({ error, onRetry }) { return <div className="error-banner"><CircleAlert size={15} /><span>{error}</span>{onRetry && <button onClick={onRetry}>Retry</button>}</div> }
function Loading() { return <div className="loading-line"><LoaderCircle size={15} />Loading local data…</div> }
function records(value) { if (Array.isArray(value)) return value; if (Array.isArray(value?.items)) return value.items; if (Array.isArray(value?.sessions)) return value.sessions; if (value && typeof value === 'object') return [value]; return [] }
function matches(row, query) { return !query || JSON.stringify(row).toLowerCase().includes(query.toLowerCase()) }
function formatValue(value) { if (value === null || value === undefined || value === '') return '—'; if (typeof value === 'boolean') return value ? 'Enabled' : 'Disabled'; if (typeof value === 'object') return Array.isArray(value) ? `${value.length} items` : '[Object]'; return String(value) }
function formatDate(value) { if (value == null) return '—'; const number = Number(value); const date = Number.isFinite(number) && number > 100000000000 ? new Date(number) : new Date(value); return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date) }
function formatBytes(value) { const bytes = Number(value); if (!Number.isFinite(bytes)) return '—'; if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`; return `${(bytes / 1024 ** 3).toFixed(1)} GB` }
function detailMetrics(row) { const preferred = ['status', 'health', 'protocol', 'latencyMs', 'agent', 'kind', 'model', 'phase', 'calls', 'events', 'name', 'alias', 'updatedAt']; const chosen = preferred.filter((key) => row[key] !== undefined && row[key] !== null).slice(0, 3); if (chosen.length < 3) chosen.push(...Object.keys(row).filter((key) => !['id', 'createdAt', 'updatedAt', ...chosen].includes(key)).slice(0, 3 - chosen.length)); return chosen.map((key) => [key, row[key]]) }
function humanize(value) { return String(value || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) }
function readableError(error) { return error?.code ? `${error.code}${error.status ? ` · HTTP ${error.status}` : ''}` : error instanceof Error ? error.message : String(error) }
function ActivityIcon(props) { return <Activity {...props} /> }
function PlayIcon(props) { return <Play {...props} /> }
