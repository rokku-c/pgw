#!/usr/bin/env bun
import { createProgram } from "./program";
import { writeError } from "./output";

const program = createProgram();
program.exitOverride();
if (process.argv.includes("--json") && (process.argv.includes("--version") || process.argv.includes("-v"))) {
  process.stdout.write(`${JSON.stringify({ name: "pgw", version: program.version(), apiVersion: 1 })}\n`);
  process.exit(0);
}
try {
  await program.parseAsync(process.argv);
} catch (error) {
  const options = program.opts();
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
  if (code === "commander.helpDisplayed" || code === "commander.version") {
    process.exitCode = 0;
  } else {
    const usage = code.startsWith("commander.");
    writeError(error, options, usage);
    process.exitCode = usage ? 2 : 1;
  }
}
