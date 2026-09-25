import type { CliOptions, HumanRenderer } from "./types";

const ANSI = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  cyan: "\u001b[36m",
};

function useColor(options: CliOptions) {
  return options.color !== false && Boolean(process.stdout.isTTY);
}

export function colorize(text: string, color: keyof typeof ANSI, options: CliOptions) {
  return useColor(options) ? `${ANSI[color]}${text}${ANSI.reset}` : text;
}

export function formatNumber(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat().format(number) : "—";
}

export function formatDuration(value: unknown) {
  const milliseconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(milliseconds)) return "—";
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatStatus(value: unknown, options: CliOptions) {
  const status = String(value ?? "unknown");
  const symbol = ["ok", "ready", "running", "completed", "enabled"].includes(status)
    ? "✓"
    : ["failed", "error", "disabled", "cancelled"].includes(status)
      ? "×"
      : ["pending", "queued", "paused", "waiting"].includes(status)
        ? "·"
        : "?";
  const tone = symbol === "✓" ? "green" : symbol === "×" ? "red" : "yellow";
  return `${colorize(symbol, tone, options)} ${status}`;
}

export function truncate(value: unknown, width = 72) {
  const text = String(value ?? "—").replace(/\s+/g, " ").trim();
  return text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text;
}

export function renderTable(
  columns: Array<{ key: string; label: string; width?: number }>,
  rows: Array<Record<string, unknown>>,
) {
  if (!rows.length) return "No results.";
  const widths = columns.map((column) =>
    Math.min(
      column.width ?? 32,
      Math.max(column.label.length, ...rows.map((row) => truncate(row[column.key], column.width ?? 32).length)),
    ),
  );
  const header = columns.map((column, index) => column.label.padEnd(widths[index])).join("  ");
  const divider = widths.map((width) => "─".repeat(width)).join("  ");
  const body = rows.map((row) =>
    columns
      .map((column, index) => truncate(row[column.key], widths[index]).padEnd(widths[index]))
      .join("  "),
  );
  return [header, divider, ...body].join("\n");
}

export function renderSummary(title: string, values: Record<string, unknown>) {
  const lines = Object.entries(values).map(([label, value]) => `${label}: ${value ?? "—"}`);
  return [title, ...lines].join("\n");
}

export function writeValue<T>(value: T, options: CliOptions, human: string | HumanRenderer<T>) {
  if (options.quiet) return;
  if (options.raw && typeof value === "string") {
    process.stdout.write(`${value}${value.endsWith("\n") ? "" : "\n"}`);
    return;
  }
  if (options.json || options.raw) {
    process.stdout.write(`${JSON.stringify(value, null, options.json ? 0 : 2)}\n`);
    return;
  }
  process.stdout.write(`${typeof human === "function" ? human(value) : human}\n`);
}

export function writeRaw<T>(value: T, options: CliOptions) {
  if (options.quiet) return;
  process.stdout.write(`${options.json ? JSON.stringify(value) : JSON.stringify(value, null, 2)}\n`);
}

export function writeError(error: unknown, options: CliOptions, usage = false) {
  const message = error instanceof Error ? error.message : String(error);
  if (options.json) {
    process.stderr.write(`${JSON.stringify({ error: { code: usage ? "usage_error" : "cli_error", message } })}\n`);
  } else {
    process.stderr.write(`${colorize("Error:", "red", options)} ${message}\n`);
  }
}
