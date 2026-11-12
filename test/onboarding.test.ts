// Per-teammate setup megaprompts, `nightshift join`, and `start --wait-for-go`.
import { describe, it, expect } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { teammatePrompt } from "../src/onboarding.js";
import { Setup } from "../src/setup.js";
import { NightConfig, Task } from "../src/config.js";
import { formatPost } from "../src/board/envelope.js";
import { makeTeam } from "./helpers.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "bin", "nightshift.mjs");

const setup = Setup.parse({
  event: { name: "HackTX 2027" },
  team: [
    { id: "maya", name: "Maya Chen", github: "mayac", os: "mac", agent: "claude", roles: "frontend" },
    { id: "jordan", name: "Jordan Ruiz", github: "jruiz", os: "windows", agent: "codex", roles: "backend" },
  ],
});
const cfg = NightConfig.parse({
  board: { kind: "github", repo: "team/quiet-hours", issue: 3 },
  nodes: [
    { id: "maya", name: "Maya Chen", lanes: ["frontend"] },
    { id: "jordan", name: "Jordan Ruiz", lanes: ["backend"] },
  ],
  authorize: { board_posts: true, merge_to_night_branch: true, work_stealing: true, contract_changes: true, decide_with_assumptions: true },
});
const tasks = [Task.parse({ id: "B1", title: "Handoff API", lane: "backend", lease: ["api/**"] }), Task.parse({ id: "F1", title: "Nurse screen", lane: "frontend", lease: ["web/**"] })];

describe("setup megaprompts", () => {
  it("is tailored to the teammate's OS, agent, identity and tasks", () => {
    const md = teammatePrompt({ setup, cfg, tasks, member: setup.team[1], repo: "team/quiet-hours", leadName: "Maya Chen" });
    expect(md).toContain("# Nightshift setup for Jordan Ruiz");
    expect(md).toContain("paste this whole file into Codex on your Windows computer");
    expect(md).toContain("winget install GitHub.cli");
    expect(md).toContain("codex login status");
    expect(md).not.toContain("claude auth status");
    expect(md).toContain("must print **jruiz**");
    expect(md).toContain("join https://github.com/team/quiet-hours --node jordan");
    expect(md).toContain("preflight --node jordan");
    expect(md).toContain("start --node jordan --wait-for-go");
    expect(md).toContain("B1: Handoff API");
    expect(md).not.toContain("F1: Nurse screen");
    expect(md).toContain("Never type, ask for, or store passwords");
    expect(md).toContain("Git Bash");
    const mac = teammatePrompt({ setup, cfg, tasks, member: setup.team[0], repo: "team/quiet-hours", leadName: "Maya Chen" });
    expect(mac).toContain("Claude Code on your macOS computer");
    expect(mac).toContain("claude auth status");
    expect(mac).toContain("brew install gh");
    expect(mac).not.toContain("winget");
  });
});

const runCli = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

describe("nightshift join", () => {
  it("updates an existing checkout and records which teammate this computer is", () => {
    const team = makeTeam({ tasks: [] });
    const parent = join(team.dir, "laptop");
    mkdirSync(parent);
    execFileSync("git", ["clone", "-q", team.remote, join(parent, "remote")]);
    const out = runCli(team.dir, ["join", "https://github.com/someone/remote", "--node", "diego", "--dir", parent]);
    expect(out).toContain("This computer is Diego (diego)");
    expect(out).toContain(`PROJECT_DIR=${join(parent, "remote")}`);
    expect(readFileSync(join(parent, "remote", ".nightshift", "local", "node"), "utf8")).toBe("diego");
    expect(() => runCli(team.dir, ["join", "someone/remote", "--node", "nobody", "--dir", parent])).toThrow(/not on this team/);
  }, 60_000);
});

describe("start --wait-for-go", () => {
  it("waits until the lead says go, then runs the night", async () => {
    const team = makeTeam({ tasks: [{ id: "W1", title: "web", lane: "frontend", lease: ["web/**"], fake: { writes: { "web/a.txt": "a" } } }] });
    const child = spawn(process.execPath, [CLI, "start", "--node", "ethan", "--wait-for-go", "--skip-preflight", "--no-keep-awake", "--no-dashboard"], {
      cwd: team.clones.ethan,
      env: { ...process.env, NIGHTSHIFT_GO_POLL_MS: "300" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const exited = new Promise<number>((r) => child.on("exit", (c) => r(c ?? 1)));
    await new Promise((r) => setTimeout(r, 4000));
    expect(out).toContain("Waiting for the team lead");
    expect(existsSync(team.board) && readFileSync(team.board, "utf8")).toContain('\\"type\\":\\"ready\\"');
    // Still waiting: nothing merged yet.
    expect(() => team.git("rev-parse", "--verify", "night/2026-11-11")).toThrow();
    appendFileSync(team.board, JSON.stringify({ author: "file", createdAt: new Date().toISOString(), text: formatPost("[Aditri's Nightshift] go", { v: 1, from: "aditri", to: "*", type: "go", body: {}, at: Date.now(), night: "2026-11-11" }) }) + "\n");
    const code = await Promise.race([exited, new Promise<number>((r) => setTimeout(() => r(-1), 45_000))]);
    if (code === -1) child.kill("SIGKILL");
    expect(out).toContain("the lead said go");
    expect(code).toBe(0);
    expect(team.git("ls-tree", "-r", "--name-only", "night/2026-11-11")).toContain("web/a.txt");
  }, 60_000);
});
