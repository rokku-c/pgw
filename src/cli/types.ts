export interface CliOptions {
  json?: boolean;
  quiet?: boolean;
  color?: boolean;
  raw?: boolean;
  access?: string;
}

export interface CliContext {
  options: Required<Pick<CliOptions, "json" | "quiet" | "color" | "raw">> &
    Pick<CliOptions, "access">;
  request<T>(path: string, method?: string, body?: unknown): Promise<T>;
  ensureServer(): Promise<void>;
}

export type HumanRenderer<T = unknown> = (value: T) => string;
