import {
  contextSnapshots,
  inspectContextSnapshot,
  compareContextSnapshots,
  deleteContextSnapshot,
} from "./trajectory-snapshots";
import { ApiError } from "./security";
import { inspectTrajectory, compareTrajectory } from "./trajectory-inspector";
import {
  trajectorySessions,
  trajectoryNodes,
  trajectoryNodeDetail,
} from "./trajectory-sessions";

let chain = Promise.resolve();
const pending = new Map<number, AbortController>();
(globalThis as any).onmessage = (event: MessageEvent) => {
  const message = event.data;
  if (message.type === "cancel") {
    pending.get(message.sequence)?.abort();
    return;
  }
  if (message.type !== "read") return;
  const controller = new AbortController();
  pending.set(message.sequence, controller);
  chain = chain
    .then(async () => {
      try {
        if (controller.signal.aborted) return;
        let result: unknown;
        if (message.operation === "snapshot.list")
          result = await contextSnapshots(message.args);
        else if (message.operation === "snapshot.inspect")
          result = await inspectContextSnapshot(
            message.args,
            controller.signal,
          );
        else if (message.operation === "snapshot.compare")
          result = await compareContextSnapshots(
            message.args,
            controller.signal,
          );
        else if (message.operation === "snapshot.delete")
          result = await deleteContextSnapshot(message.args.id);
        else if (message.operation === "inspect")
          result = await inspectTrajectory(message.args, controller.signal);
        else if (message.operation === "compare")
          result = await compareTrajectory(message.args, controller.signal);
        else if (message.operation === "sessions")
          result = await trajectorySessions(message.args);
        else if (message.operation === "nodes")
          result = await trajectoryNodes(message.args);
        else if (message.operation === "node")
          result = await trajectoryNodeDetail(message.args);
        else throw new ApiError(400, "unsupported_operation");
        if (!controller.signal.aborted)
          (globalThis as any).postMessage({
            type: "read",
            sequence: message.sequence,
            result,
          });
      } catch (error) {
        if (!controller.signal.aborted)
          (globalThis as any).postMessage({
            type: "read",
            sequence: message.sequence,
            error:
              error instanceof ApiError ? error.code : "capture_unavailable",
            status: error instanceof ApiError ? error.status : 500,
          });
      } finally {
        pending.delete(message.sequence);
      }
    })
    .catch(() => {});
};
