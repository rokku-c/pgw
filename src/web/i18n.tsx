import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import zh from "./locales/zh-CN";
import en from "./locales/en-US";

type Locale = "zh-CN" | "en-US";
const dictionaries = { "zh-CN": zh, "en-US": en } as const;
type Key = keyof typeof zh;

const literalKeys: Partial<Record<string, Key>> = {
  "Workspace": "workspace.name", "LOCAL WORKSPACE": "workspace.local", "Search": "nav.search",
  "Overview": "nav.overview", "Models": "nav.models", "Traffic": "nav.traffic", "Observe": "nav.observability", "Observability": "nav.observability", "Sessions": "nav.sessions", "Registry": "nav.registry", "Persona": "nav.persona", "Runs": "nav.runs", "Playground": "nav.playground", "Jobs": "nav.jobs", "Control": "nav.control", "Settings": "nav.settings",
  "Refresh": "common.refresh", "Back": "common.back", "Cancel": "common.cancel", "Save": "common.save", "Create": "common.create", "Confirm": "common.confirm", "Retry": "common.retry", "Run": "common.run", "Stop": "common.stop", "Continue": "common.resume", "Loading": "common.loading", "Copy": "common.copy", "Copied": "common.copied", "Close": "common.close", "Execute": "common.execute", "Restore": "common.restore", "Reject": "common.reject", "Disable": "common.disable", "Enable": "common.enable", "Read": "common.read", "History": "common.history", "Scan": "common.scan", "Edit": "common.edit", "Export": "common.export", "Collapse": "common.collapse", "Submit": "common.submit",
  "Add preference": "common.addPreference", "From event": "common.fromEvent", "Open traffic": "common.openTraffic", "Scan assets": "common.scanRegistry", "Export inventory": "common.exportInventory", "Detail": "common.detail", "Inspect": "common.inspect", "Delete": "common.delete", "Actions": "common.actions", "Status": "common.status", "Created": "common.created", "No records": "common.noRecords", "No requests yet": "common.noRequests", "No jobs": "common.noJobs", "Run a request to inspect the response": "common.runRequest", "Gateway online": "common.gatewayOnline",
  "Local": "status.local", "Disconnected": "status.disconnected", "Switch to light theme": "theme.light", "Switch to dark theme": "theme.dark",
  "A compact view of gateway health, throughput, and recent activity.": "page.overview.description", "Configure upstream providers, logical routes, and client access.": "page.models.description", "Read requests as a sequence of stages, attempts, and related session calls.": "page.traffic.description", "Follow an agent trajectory from session to node evidence.": "page.observability.description", "Browse local sessions, events, and searchable working memory.": "page.sessions.description", "Manage local agents, skills, asset roots, deployments, and MCP.": "page.registry.description", "Manage preferences, history, evidence, and event-derived candidates.": "page.persona.description", "Inspect agent runs, progress, controls, and execution results.": "page.runs.description", "Execute a real gateway request and inspect every debug attempt.": "page.playground.description", "Inspect job progress, results, attempts, and retry/cancel actions.": "page.jobs.description", "Handle approvals, routing state, MCP calls, and runtime controls.": "page.control.description", "Gateway policies, capture limits, adaptive context, retries, and storage.": "page.settings.description",
};

const I18nContext = createContext({ locale: "zh-CN" as Locale, setLocale: (_: Locale) => {}, t: (key: string) => key, translate: (value: string) => value });

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(() => (localStorage.getItem("pgw-locale") as Locale) || "zh-CN");
  const value = useMemo(() => ({
    locale,
    setLocale: (next: Locale) => { localStorage.setItem("pgw-locale", next); setLocale(next); },
    t: (key: string) => (dictionaries[locale] as Record<string, string>)[key] || (dictionaries["en-US"] as Record<string, string>)[key] || key,
    translate: (literal: string) => {
      const key = literalKeys[literal];
      return key ? (dictionaries[locale] as Record<string, string>)[key] || literal : literal;
    },
  }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);
export type LocaleKey = Key;
