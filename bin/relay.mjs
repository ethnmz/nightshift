#!/usr/bin/env node
// Launcher: runs the TypeScript CLI through tsx's loader. Works the same on macOS, Windows and Linux
// (no shell scripts or .cmd shims involved).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const loader = import.meta.resolve("tsx");
const args = process.argv.slice(2);
const r = spawnSync(process.execPath, ["--import", loader, join(root, "src", "cli.ts"), ...(args.length ? args : ["ui"])], { stdio: "inherit" });
process.exit(r.status ?? 1);
