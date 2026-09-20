const result = await Bun.build({ entrypoints: ["src/web/index.html"], outdir: "dist/web", target: "browser", minify: true });
if (!result.success) throw new AggregateError(result.logs, "Build failed");
console.log(`${result.outputs.length} assets → dist/web`);

export {};
