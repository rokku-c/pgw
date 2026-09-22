import { cp } from "node:fs/promises";

const result = await Bun.build({ entrypoints: ["src/web/index.html"], outdir: "dist/web", target: "browser", minify: true });
if (!result.success) throw new AggregateError(result.logs, "Build failed");
await cp("src/web/pwa", "dist/web/pwa", { recursive: true });
console.log(`${result.outputs.length} assets → dist/web`);

export {};
