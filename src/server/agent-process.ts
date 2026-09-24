import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ApiError } from "./security";

export class AgentProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<number | null>;
  private sequence = 0;
  private pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private closed = false;
  private queue = Promise.resolve();
  constructor(
    argv: string[],
    options: {
      cwd: string;
      env: Record<string, string | undefined>;
      onEvent: (event: any) => Promise<void>;
      onError: (error: Error) => void;
      onStderr: (text: string) => void;
    },
  ) {
    this.child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.exited = new Promise((resolve) => {
      this.child.once("error", (error) => {
        this.fail(error);
        options.onError(error);
        resolve(null);
      });
      this.child.once("close", (code) => {
        this.closed = true;
        this.fail(new Error(`agent_exited:${code}`));
        resolve(code);
      });
    });
    this.child.stdin.on("error", (error) => {
      this.fail(error);
      options.onError(error);
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (text) => options.onStderr(String(text)));
    this.child.stdout.setEncoding("utf8");
    let pending = "";
    this.child.stdout.on("data", (chunk) => {
      pending += chunk;
      if (pending.length > 8 * 1024 * 1024) {
        options.onError(new Error("agent_event_too_large"));
        void this.close();
        return;
      }
      let boundary: number;
      while ((boundary = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, boundary);
        pending = pending.slice(boundary + 1);
        if (!line.trim()) continue;
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          options.onError(new Error("invalid_agent_event"));
          continue;
        }
        const key = String(message.id);
        const waiting = this.pending.get(key);
        if (
          waiting &&
          ("result" in message ||
            "error" in message ||
            message.type === "response")
        ) {
          this.pending.delete(key);
          clearTimeout(waiting.timeout);
          if (message.error || message.success === false)
            waiting.reject(
              new Error(
                message.error?.message ||
                  message.error ||
                  "agent_request_failed",
              ),
            );
          else waiting.resolve(message.result ?? message.data ?? {});
        } else {
          this.queue = this.queue
            .then(() => options.onEvent(message))
            .catch((error) =>
              options.onError(
                error instanceof Error ? error : new Error(String(error)),
              ),
            );
        }
      }
    });
  }
  send(message: unknown) {
    if (this.closed || this.child.stdin.destroyed)
      throw new ApiError(409, "agent_disconnected");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request(method: string, params: unknown, rpc = false): Promise<any> {
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`agent_request_timeout:${method}`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.send(
          rpc
            ? { id, type: method, ...(params as object) }
            : { id, method, params },
        );
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  private fail(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
  async drained() {
    await this.queue;
  }
  async close() {
    if (!this.closed && this.child.pid) {
      const kill = (signal: NodeJS.Signals) => {
        try {
          process.platform === "win32"
            ? this.child.kill(signal)
            : process.kill(-this.child.pid!, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      };
      kill("SIGTERM");
      const timeout = setTimeout(() => {
        if (!this.closed) kill("SIGKILL");
      }, 3000);
      try {
        await this.exited;
      } finally {
        clearTimeout(timeout);
      }
    }
    await this.queue;
  }
}
