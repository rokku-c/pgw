import { selfArgv } from "./self";

/**
 * A lane's job runner: a persistent child process running `__job` in this same
 * executable, spoken to over Bun's IPC.
 *
 * This replaces `new Worker(new URL("./job-worker.ts", ...))`, which cannot work
 * in a compiled binary. Bun emits a TS worker entrypoint into the virtual `$bunfs`
 * as `job-worker.js` while `import.meta.url` resolution still asks for
 * `job-worker.ts`, so the thread dies with `ModuleNotFound`. Listing the worker as
 * a second entrypoint fixes the resolution but splits shared dependencies across
 * chunks — zod then throws `undefined is not a constructor (ZodLazy)` inside the
 * worker thread, which never runs the parent's chunk-init.
 *
 * A child process sidesteps both: one entrypoint, one graph, no split. The IPC
 * surface mirrors the old Worker surface (`postMessage` / `onmessage` / `onerror`
 * / `terminate`) so `jobs.ts` is otherwise unchanged.
 */
export class LaneRunner {
  private child: Bun.Subprocess;
  private closed = false;
  onmessage?: (data: any) => void;
  onerror?: (message: string) => void;

  constructor() {
    this.child = Bun.spawn([process.execPath, ...selfArgv("__job")], {
      ipc: message => this.onmessage?.(message),
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env },
    });
    // Mirror Worker.onerror: surface an unexpected exit to the lane so it can mark
    // the in-flight job `uncertain` rather than leaving it stuck at `running`.
    void this.child.exited.then(code => {
      if (this.closed) return;
      this.closed = true;
      this.onerror?.(`job runner exited with code ${code}`);
    });
  }

  postMessage(message: unknown) {
    this.child.send(message);
  }

  terminate() {
    this.closed = true;
    this.child.kill();
  }
}
