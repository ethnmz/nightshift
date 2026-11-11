// Run in the evening on every Mac, while people are still awake. Anything that could make
// the night stall at 3 a.m. (auth, push access, sleep, power, a broken check) fails here.
import { mkdtempSync, rmSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadNight, loadTasks, missingAuthorizations, nightBranch, nightName, findNode } from "./config.js";
import { Git } from "./git.js";
import { run, sh, childEnv } from "./exec.js";

export type CheckStatus = "pass" | "warn" | "fail";
export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

export async function preflight(root: string, nodeId: string, opts: { live?: boolean } = {}): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const add = (name: string, status: CheckStatus, detail: string) => out.push({ name, status, detail });

  // 1. Plan and pre-authorization
  let cfg;
  try {
    cfg = loadNight(root);
    add("night.yaml", "pass", `${cfg.nodes.length} nodes, board: ${cfg.board.kind}`);
  } catch (e) {
    add("night.yaml", "fail", String(e));
    return out;
  }
  try {
    const tasks = loadTasks(root);
    const lanes = new Set(cfg.nodes.flatMap((n) => n.lanes));
    const orphan = tasks.filter((t) => !lanes.has(t.lane));
    add("tasks.yaml", orphan.length ? "fail" : "pass", orphan.length ? `lanes with no node: ${[...new Set(orphan.map((t) => t.lane))].join(", ")}` : `${tasks.length} tasks, DAG valid`);
  } catch (e) {
    add("tasks.yaml", "fail", String(e));
  }
  const missing = missingAuthorizations(cfg);
  add("evening authorizations", missing.length ? "fail" : "pass", missing.length ? `not granted: ${missing.join(", ")} (the night would stall waiting for a person)` : "all standing decisions granted");
  let me;
  try {
    me = findNode(cfg, nodeId);
    add("node", "pass", `${me.name} (${me.id}), lanes ${me.lanes.join(", ")}`);
  } catch (e) {
    add("node", "fail", String(e));
    return out;
  }

  // 2. Git remote: read, push to night/*, compare-and-swap refs (the claim mechanism)
  const git = new Git(root, { name: "nightshift preflight", email: `${me.id}@nightshift.local` });
  const ls = await git.raw(["ls-remote", "--heads", cfg.remote, cfg.base_branch]);
  add("remote reachable", ls.code === 0 && ls.stdout.includes(cfg.base_branch) ? "pass" : "fail", ls.code === 0 ? `${cfg.remote}/${cfg.base_branch}` : ls.stderr.trim().slice(0, 300));
  const head = await git.revParse("HEAD");
  if (head) {
    const night = nightBranch(nightName(cfg));
    const dry = await git.raw(["push", "--dry-run", "--quiet", cfg.remote, `${head}:refs/heads/${night}-preflight-${me.id}`]);
    add("push access (night branch)", dry.code === 0 ? "pass" : "fail", dry.code === 0 ? `can push to ${night}` : dry.stderr.trim().slice(0, 300));
    const ref = `refs/nightshift/preflight/${me.id}`;
    const tree = await git.emptyTree().catch(() => "");
    const sha = tree ? await git.ok(["commit-tree", tree, "-m", "preflight"]).catch(() => "") : "";
    const create = sha ? await git.raw(["push", "--quiet", `--force-with-lease=${ref}:`, cfg.remote, `${sha}:${ref}`]) : { code: 1, stderr: "commit-tree failed" };
    const del = await git.raw(["push", "--quiet", cfg.remote, `:${ref}`]);
    add("claim refs (compare-and-swap)", create.code === 0 && del.code === 0 ? "pass" : "fail", create.code === 0 ? "create + delete ok" : String(create.stderr).trim().slice(0, 300));
  }
  const dirty = await git.raw(["status", "--porcelain", "--untracked-files=no"]);
  add("checkout", dirty.stdout.trim() ? "warn" : "pass", dirty.stdout.trim() ? "uncommitted changes in this checkout (worktrees start from the remote, so they are not included)" : "clean");

  // 3. Board access as this teammate's own login
  if (cfg.board.kind === "github") {
    const who = await run("gh", ["api", "user", "--jq", ".login"], { timeoutMs: 20_000 });
    const login = who.stdout.trim();
    if (who.code !== 0) add("gh auth", "fail", "gh is not logged in. Run: gh auth login");
    else if (me.login && login.toLowerCase() !== me.login.toLowerCase()) add("gh auth", "fail", `gh is logged in as ${login}, night.yaml says ${me.login}. One login per teammate, or nodes miss each other.`);
    else add("gh auth", "pass", login);
    const repo = cfg.board.repo;
    if (repo) {
      const issue = await run("gh", ["api", `repos/${repo}/issues/${cfg.board.issue}`, "--jq", ".title"], { timeoutMs: 20_000 });
      add("board issue", issue.code === 0 ? "pass" : "fail", issue.code === 0 ? `#${cfg.board.issue}: ${issue.stdout.trim()}` : issue.stderr.trim().slice(0, 200));
    }
  } else add("board", "pass", `file board ${cfg.board.path} (rehearsal mode: all nodes must share this path)`);

  // 4. The global check runs, non-interactively, on a fresh copy of the base branch
  if (cfg.check) {
    const tmp = mkdtempSync(join(tmpdir(), "nightshift-preflight-"));
    const wt = join(tmp, "wt");
    const base = `refs/remotes/${cfg.remote}/${cfg.base_branch}`;
    await git.raw(["fetch", "--quiet", cfg.remote, `+refs/heads/${cfg.base_branch}:${base}`]);
    const add1 = await git.raw(["worktree", "add", "--quiet", "--detach", wt, base]);
    if (add1.code === 0) {
      const r = await sh(cfg.check, { cwd: wt, timeoutMs: cfg.limits.command_timeout_seconds * 1000 });
      add("global check on base", r.code === 0 ? "pass" : "warn", r.code === 0 ? cfg.check : `exit ${r.code}${r.timedOut ? " (timed out: does it wait for input or run a server?)" : ""}: ${(r.stderr || r.stdout).trim().slice(-300)} — tasks must make it pass`);
      await git.raw(["worktree", "remove", "--force", wt]);
    } else add("global check on base", "fail", add1.stderr.trim().slice(0, 200));
    rmSync(tmp, { recursive: true, force: true });
  } else add("global check", "warn", "no `check` command: merges are only guarded by per-task acceptance");

  // 5. The Mac stays awake, on power, with room to work
  if (process.platform === "darwin") {
    const batt = await run("pmset", ["-g", "batt"], { timeoutMs: 5000 });
    add("power", batt.stdout.includes("AC Power") ? "pass" : "fail", batt.stdout.includes("AC Power") ? "on AC power" : "on battery: plug in, or the Mac may sleep and its claims go stale");
    const caf = await run("which", ["caffeinate"], { timeoutMs: 5000 });
    add("caffeinate", caf.code === 0 ? "pass" : "fail", caf.code === 0 ? "start keeps the Mac awake with caffeinate -dimsu" : "caffeinate missing");
    const lid = await run("pmset", ["-g"], { timeoutMs: 5000 });
    const sleepMin = /\bsleep\s+(\d+)/.exec(lid.stdout)?.[1];
    add("system sleep", "pass", `sleep=${sleepMin ?? "?"} min; caffeinate holds it off. Keep the lid open (or use an external display).`);
    const upd = await run("defaults", ["read", "/Library/Preferences/com.apple.SoftwareUpdate", "AutomaticallyInstallMacOSUpdates"], { timeoutMs: 5000 });
    add("auto OS updates", upd.stdout.trim() === "1" ? "warn" : "pass", upd.stdout.trim() === "1" ? "automatic macOS installs are on; an overnight restart would stop this node (others take over its tasks)" : "no automatic restart configured");
  }
  try {
    const fs = statfsSync(root);
    const gb = (fs.bavail * fs.bsize) / 1e9;
    add("disk", gb > 5 ? "pass" : "fail", `${gb.toFixed(1)} GB free`);
  } catch {
    /* not critical */
  }

  // 6. The model is reachable and answers without any prompt
  if (cfg.adapter === "claude") {
    if (opts.live === false) add("claude", "warn", "live check skipped (--skip-live)");
    else {
      try {
        let ok = false;
        let cost = 0;
        for await (const m of query({
          prompt: "Reply with exactly: OK",
          options: { maxTurns: 1, permissionMode: "dontAsk", settingSources: [], model: cfg.models.builder, env: childEnv() },
        })) {
          if (m.type === "result") {
            ok = m.subtype === "success" && /OK/.test(m.result ?? "");
            cost = m.total_cost_usd;
          }
        }
        add("claude", ok ? "pass" : "fail", ok ? `model answered headless ($${cost.toFixed(4)})${cfg.models.builder ? `, model ${cfg.models.builder}` : ""}` : "no OK from the model: check login / ANTHROPIC_API_KEY");
      } catch (e) {
        add("claude", "fail", String(e).slice(0, 300));
      }
    }
  } else add("adapter", "warn", `adapter is "${cfg.adapter}": no real agents will run (rehearsal)`);

  add("budget", "pass", `$${cfg.budget.node_usd} per node, $${cfg.budget.team_usd} team, ${cfg.concurrency} workers per node`);
  return out;
}

export function preflightOk(r: CheckResult[]): boolean {
  return !r.some((x) => x.status === "fail");
}
