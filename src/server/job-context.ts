import { atomic } from "./transactions";
import { ApiError } from "./security";
export interface WorkContext {
  check: () => Promise<void>;
  progress: (phase: string, processed: number, total?: number | null, item?: string | null) => Promise<void>;
  signal: AbortSignal;
}
export function jobContext(id: string) {
  const controller = new AbortController();
  let lastCheck = 0, lastWrite = 0;
  const check = async () => {
    if (controller.signal.aborted) throw new ApiError(499,"job_cancelled");
    if (Date.now() - lastCheck < 100) return;
    lastCheck = Date.now();
    const value = await atomic(database => database.query('SELECT cancelRequested,status FROM background_jobs WHERE id=?').get(id) as { cancelRequested: number; status: string } | null);
    if (!value || value.cancelRequested || !["running","waiting"].includes(value.status)) { controller.abort(); throw new ApiError(499,"job_cancelled"); }
  };
  const timer = setInterval(() => { void check().catch(() => {}); }, 250);
  return {
    context: { check, signal: controller.signal,
      async progress(phase: string, processed: number, total: number | null = null, item: string | null = null) {
        await check();
        if (Date.now()-lastWrite<200) return;
        lastWrite=Date.now();
        await atomic(database=>database.query("UPDATE background_jobs SET phase=?,processed=?,total=?,currentItem=?,heartbeatAt=?,updatedAt=? WHERE id=? AND status IN ('running','waiting')").run(phase,processed,total,item,Date.now(),Date.now(),id));
      },
    } satisfies WorkContext,
    cancel() { controller.abort(); },
    close() { clearInterval(timer); },
  };
}

export class RetryScheduled extends Error { constructor(){super("retry_scheduled");} }
