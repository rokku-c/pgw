import { errorKey } from "./api";
import { tr, trError, useI18n } from "./i18n";
import { useState } from "react";
import { CheckIcon, PlugsConnectedIcon, ShieldCheckIcon } from "@phosphor-icons/react";
import { api, useResource, errorText } from "./api";
import { Badge, Button, Modal, Toggle, Copy, Panel, Header } from "./components";
import type { McpGrant, PublicMcpConnection, PublicClient } from "../shared/types";

export function McpGrantEditor({ grants, onChange, memory, onMemory }: { grants: McpGrant[]; onChange: (grants: McpGrant[]) => void; memory: boolean; onMemory: (value: boolean) => void }) {
  const connections = useResource<PublicMcpConnection[]>("/mcp");
  function edit(connection: PublicMcpConnection, kind: "tools" | "resources" | "prompts", name: string, selected: boolean) {
    const previous = grants.find(g => g.connectionId === connection.id);
    const grant: McpGrant = previous?.schemaHash === connection.schemaHash ? { ...previous } : { connectionId: connection.id, schemaHash: connection.schemaHash!, tools: [], resources: [], prompts: [], requireApproval: true };
    grant[kind] = selected ? [...new Set([...grant[kind], name])] : grant[kind].filter(n => n !== name);
    onChange([...grants.filter(g => g.connectionId !== connection.id), ...(grant.tools.length || grant.resources.length || grant.prompts.length ? [grant] : [])]);
  }
  return <div className="mcp-grant-editor"><div className="form-switch"><div><span>{tr("memory.access.title")}</span><small>{tr("memory.access.scope")}</small></div><Toggle label={tr("memory.access.label")} checked={memory} onChange={onMemory}/></div>{connections.data?.filter(c => c.enabled && c.schemaHash).map(connection => {
    const grant = grants.find(g => g.connectionId === connection.id);
    const stale = !!grant && grant.schemaHash !== connection.schemaHash;
    return <details className="grant-connection" key={connection.id} open={!!grant}><summary><PlugsConnectedIcon size={16}/><span>{connection.name}</span><Badge>{(grant?.tools.length || 0) + (grant?.resources.length || 0) + (grant?.prompts.length || 0)}</Badge>{stale && <Badge>{tr("mcp.catalog.changed")}</Badge>}</summary>{stale && <div className="grant-stale"><span>{tr("mcp.grant.review")}</span><Button onClick={() => onChange(grants.filter(g => g.connectionId !== connection.id))}>{tr("mcp.grant.clear")}</Button></div>}<div className="grant-options">{([
      { kind: "tools", title: "TOOLS", items: connection.tools.map(t => ({ id: t.name, name: t.name })) },
      { kind: "resources", title: "RESOURCES", items: connection.resources.map(r => ({ id: r.uri, name: r.name })) },
      { kind: "prompts", title: "PROMPTS", items: connection.prompts.map(p => ({ id: p.name, name: p.name })) },
    ] as const).map(group => group.items.length > 0 && <div key={group.kind}><span className="grant-kind mono">{group.title}</span>{group.items.map(item => <label className="grant-checkbox" key={item.id}><input type="checkbox" checked={!stale && !!grant?.[group.kind].includes(item.id)} onChange={e => edit(connection, group.kind, item.id, e.target.checked)}/><span className="mono">{item.name}</span></label>)}</div>)}</div>{grant && !stale && <div className="form-switch grant-approval"><span><ShieldCheckIcon size={13}/>{tr("mcp.grant.approval")}</span><Toggle label={tr("mcp.grant.approvalNamed", { name: connection.name })} checked={grant.requireApproval} onChange={requireApproval => onChange(grants.map(g => g.connectionId === connection.id ? { ...g, requireApproval } : g))}/></div>}</details>;
  })}{connections.error && <div className="form-error">{errorText(new Error(connections.error))}</div>}</div>;
}
export function ClientAccess({ client, close, saved }: { client: PublicClient; close: () => void; saved: () => void }) {
  const [grants, setGrants] = useState(client.mcpGrants), [memory, setMemory] = useState(client.memoryAccess), [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <Modal title={`${client.name} · MCP`} open onOpenChange={close}><div className="access-launch"><code>pgw --access {client.id} codex</code><Copy value={`pgw --access ${client.id} codex`}/></div><McpGrantEditor grants={grants} onChange={setGrants} memory={memory} onMemory={setMemory}/>{error && <div className="form-error" role="alert">{trError(error)}</div>}<div className="form-actions"><Button onClick={close}>{tr("common.cancel")}</Button><Button className="primary" icon={<CheckIcon size={14}/>} busy={busy} onClick={async () => { setBusy(true); try { await api(`/clients/${client.id}`, { method: "PATCH", body: JSON.stringify({ mcpGrants: grants, memoryAccess: memory }) }); saved(); } catch (error) { setError(errorKey(error)); } finally { setBusy(false); } }}>{tr("common.save")}</Button></div></Modal>;
}


export function AccessGuide({ clientId, accessKey }: { clientId: string; accessKey?: string }) {
  const { t } = useI18n();
  const endpoint = `${location.origin}/mcp`;
  const claude = `pgw --access ${clientId} claude`;
  const codex = `pgw --access ${clientId} codex`;
  const curl = `export PGW_MCP_KEY='${accessKey || "<paste-access-key>"}'

curl -sS ${endpoint} \\
  -H "Authorization: Bearer $PGW_MCP_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'`;
  const fetchCode = `const endpoint = ${JSON.stringify(endpoint)};
const token = process.env.PGW_MCP_KEY;

const call = (id, method, params = {}) => fetch(endpoint, {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${token}\`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
}).then(response => response.json());

await call(1, "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "personal-gateway-skill", version: "1" },
});
console.log(await call(2, "tools/call", {
  name: "gateway_cli",
  arguments: { command: "skills", args: ["--query", "search term"] },
}));`;
  const skill = `# Personal Gateway HTTP skill

Endpoint: ${endpoint}

Use the MCP JSON-RPC endpoint with PGW_MCP_KEY. Initialize first, then call gateway_cli.
Read-only examples:
- status: { command: "status", args: [] }
- skills: { command: "skills", args: ["--query", "..."] }
- sessions: { command: "sessions", args: ["--query", "..."] }

Do not use this skill for writes, agent runs, approvals, or storage compact.`;
  return <Panel className="access-guide"><Header title={t("client.setup.title")} /><p className="access-guide-note">{t("client.setup.note")}</p><div className="access-guide-block"><div><strong>{t("client.setup.wrapper")}</strong><Copy value={`${claude}\n${codex}`} /></div><pre>{claude}
{codex}</pre></div><div className="access-guide-block"><div><strong>{t("client.setup.curl")}</strong><Copy value={curl} /></div><pre>{curl}</pre></div><div className="access-guide-block"><div><strong>{t("client.setup.fetch")}</strong><Copy value={fetchCode} /></div><pre>{fetchCode}</pre></div><div className="access-guide-block"><div><strong>{t("client.setup.skill")}</strong><Copy value={skill} /></div><pre>{skill}</pre></div><small className="access-guide-foot">{t("client.setup.token")}</small></Panel>;
}
