// Run on every computer before a run, while people are still around. Anything that could make
// the run stall later (auth, push access, sleep, power, a broken check) fails here.
import { mkdtempSync, rmSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig, loadTasks, missingAuthorizations, runBranch, runName, findNode, agentFor, KEY_ENV } from "./config.js";
import { Git } from "./git.js";
import { run, sh, childEnv } from "./exec.js";
import { IS_MAC, IS_WIN, OS_NAME, bashPath, powerSource, resolveCli } from "./platform.js";

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
    cfg = loadConfig(root);
    add("relay.yaml", "pass", `${cfg.nodes.length} nodes, board: ${cfg.board.kind}`);
  } catch (e) {
    add("relay.yaml", "fail", String(e));
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
  add("standing authorizations", missing.length ? "fail" : "pass", missing.length ? `not granted: ${missing.join(", ")} (the run would stall waiting for a person)` : "all standing decisions granted");
  let me;
  try {
    me = findNode(cfg, nodeId);
    add("node", "pass", `${me.name} (${me.id}), lanes ${me.lanes.join(", ")}`);
  } catch (e) {
    add("node", "fail", String(e));
    return out;
  }

  // 2. Git remote: read, push to relay/*, compare-and-swap refs (the claim mechanism)
  const git = new Git(root, { name: "relay preflight", email: `${me.id}@relay.local` });
  const ls = await git.raw(["ls-remote", "--heads", cfg.remote, cfg.base_branch]);
  add("remote reachable", ls.code === 0 && ls.stdout.includes(cfg.base_branch) ? "pass" : "fail", ls.code === 0 ? `${cfg.remote}/${cfg.base_branch}` : ls.stderr.trim().slice(0, 300));
  const head = await git.revParse("HEAD");
  if (head) {
    const runId = runBranch(runName(cfg));
    const dry = await git.raw(["push", "--dry-run", "--quiet", cfg.remote, `${head}:refs/heads/${runId}-preflight-${me.id}`]);
    add("push access (run branch)", dry.code === 0 ? "pass" : "fail", dry.code === 0 ? `can push to ${runId}` : dry.stderr.trim().slice(0, 300));
    const ref = `refs/relay/preflight/${me.id}`;
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
    else if (me.login && login.toLowerCase() !== me.login.toLowerCase()) add("gh auth", "fail", `gh is logged in as ${login}, relay.yaml says ${me.login}. One login per teammate, or nodes miss each other.`);
    else add("gh auth", "pass", login);
    const repo = cfg.board.repo;
    if (repo) {
      const issue = await run("gh", ["api", `repos/${repo}/issues/${cfg.board.issue}`, "--jq", ".title"], { timeoutMs: 20_000 });
      add("board issue", issue.code === 0 ? "pass" : "fail", issue.code === 0 ? `#${cfg.board.issue}: ${issue.stdout.trim()}` : issue.stderr.trim().slice(0, 200));
    }
  } else add("board", "pass", `file board ${cfg.board.path} (rehearsal mode: all nodes must share this path)`);

  // 4. The global check runs, non-interactively, on a fresh copy of the base branch
  if (cfg.check) {
    const tmp = mkdtempSync(join(tmpdir(), "relay-preflight-"));
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

  // 5. The computer stays awake, on power, with room to work
  const power = powerSource();
  add("power", power === "battery" ? "fail" : power === "ac" ? "pass" : "warn", power === "battery" ? "on battery: plug in, or the computer may sleep and its tasks move to teammates" : power === "ac" ? "plugged in" : "could not read the power source; keep it plugged in");
  add("stay awake", "pass", IS_MAC ? "Relay holds sleep off with caffeinate while it runs. Keep the lid open." : IS_WIN ? "Relay asks Windows not to sleep while it runs. Keep the lid open (or set 'lid close: do nothing')." : "Relay uses systemd-inhibit while it runs.");
  if (IS_WIN) {
    const b = bashPath();
    add("Git Bash", b ? "pass" : "fail", b ? `checks run in ${b}` : "Git Bash not found. Install Git for Windows: winget install Git.Git");
    const lp = await run("git", ["config", "--get", "core.longpaths"], { timeoutMs: 5000 });
    add("long paths", lp.stdout.trim() === "true" ? "pass" : "warn", lp.stdout.trim() === "true" ? "git long paths on" : "deep node_modules may hit Windows path limits. Run: git config --global core.longpaths true");
  }
  if (IS_MAC) {
    const lid = await run("pmset", ["-g"], { timeoutMs: 5000 });
    const sleepMin = /\bsleep\s+(\d+)/.exec(lid.stdout)?.[1];
    add("system sleep", "pass", `sleep=${sleepMin ?? "?"} min; caffeinate holds it off. Keep the lid open (or use an external display).`);
    const upd = await run("defaults", ["read", "/Library/Preferences/com.apple.SoftwareUpdate", "AutomaticallyInstallMacOSUpdates"], { timeoutMs: 5000 });
    add("auto OS updates", upd.stdout.trim() === "1" ? "warn" : "pass", upd.stdout.trim() === "1" ? "automatic macOS installs are on; an automatic restart would stop this node (others take over its tasks)" : "no automatic restart configured");
  }
  try {
    const fs = statfsSync(root);
    const gb = (fs.bavail * fs.bsize) / 1e9;
    add("disk", gb > 5 ? "pass" : "fail", `${gb.toFixed(1)} GB free`);
  } catch {
    /* not critical */
  }

  // 6. The coding agent: installed, signed in with the teammate's SUBSCRIPTION, answers headless
  const agent = agentFor(cfg, me);
  const keysInShell = KEY_ENV.filter((k) => process.env[k]);
  if (cfg.auth === "subscription" && keysInShell.length)
    add("API keys in shell", "warn", `${keysInShell.join(", ")} set in this shell. Relay removes them from agents so your subscription is used, not the key.`);
  const agentEnv = cfg.auth === "subscription" ? KEY_ENV : [];
  if (agent === "claude") {
    const [cbin, cpre] = resolveCli("claude");
    const st = await run(cbin, [...cpre, "auth", "status"], { timeoutMs: 20_000 });
    if (st.code === 0) {
      try {
        const j = JSON.parse(st.stdout) as { loggedIn?: boolean; authMethod?: string; loginExpiresAt?: string };
        const sub = j.authMethod === "claude.ai";
        if (!j.loggedIn) add("Claude login", "fail", "Claude Code is not logged in. Run: claude  (then /login with your Claude subscription)");
        else if (cfg.auth === "subscription" && !sub) add("Claude login", "fail", `Claude Code is logged in with ${j.authMethod}, not a claude.ai subscription. Run /login and choose your Claude account.`);
        else add("Claude login", "pass", sub ? "claude.ai subscription (Pro/Max/Team)" : String(j.authMethod));
        if (j.loginExpiresAt) {
          const hrs = (Date.parse(j.loginExpiresAt) - Date.now()) / 36e5;
          add("login expiry", hrs < 16 ? "fail" : hrs < 72 ? "warn" : "pass", hrs < 16 ? `login expires in ${hrs.toFixed(1)} h, during the run. Run /login in Claude Code now.` : `login valid for ${(hrs / 24).toFixed(1)} more days`);
        }
      } catch {
        add("Claude login", "warn", "could not read `claude auth status`; the live check below confirms the login");
      }
    } else add("Claude login", "warn", "`claude` command not found; the live check below confirms the login. (Install: npm install -g @anthropic-ai/claude-code)");
    if (opts.live === false) add("Claude live check", "warn", "skipped (--skip-live)");
    else {
      try {
        let ok = false;
        let source = "";
        for await (const m of query({
          prompt: "Reply with exactly: OK",
          options: { maxTurns: 1, permissionMode: "dontAsk", settingSources: [], model: me.model ?? cfg.models.builder, env: childEnv({}, agentEnv) },
        })) {
          if (m.type === "system" && (m as { subtype?: string }).subtype === "init") source = String((m as { apiKeySource?: string }).apiKeySource ?? "");
          if (m.type === "result") ok = m.subtype === "success" && /OK/.test(m.result ?? "");
        }
        const viaSub = source === "none" || source === "oauth";
        if (!ok) add("Claude live check", "fail", "no OK from the model: check your login and plan");
        else if (cfg.auth === "subscription" && !viaSub) add("Claude live check", "fail", `answered, but through ${source} instead of your subscription`);
        else add("Claude live check", "pass", `answered headless via ${viaSub ? "your subscription" : source}${me.model ?? cfg.models.builder ? `, model ${me.model ?? cfg.models.builder}` : ""}`);
      } catch (e) {
        add("Claude live check", "fail", String(e).slice(0, 300));
      }
    }
  } else if (agent === "codex") {
    const [bin, pre] = resolveCli("codex");
    const help = await run(bin, [...pre, "exec", "--help"], { timeoutMs: 20_000 });
    const flagsOk = help.code === 0 && help.stdout.includes("--sandbox") && help.stdout.includes("workspace-write") && help.stdout.includes("--json");
    add("Codex CLI", flagsOk ? "pass" : "fail", flagsOk ? "`codex exec` supports --json and the workspace-write sandbox" : help.code !== 0 ? "codex not found. Install: npm i -g @openai/codex" : "this codex version lacks --json/--sandbox workspace-write; update it");
    const login = await run(bin, [...pre, "login", "status"], { timeoutMs: 20_000 });
    const out = (login.stdout + login.stderr).trim();
    const sub = /chatgpt/i.test(out);
    if (login.code !== 0 || /not logged in/i.test(out)) add("Codex login", "fail", "Codex is not logged in. Run: codex login  (sign in with ChatGPT)");
    else if (cfg.auth === "subscription" && !sub) add("Codex login", "fail", `Codex uses "${out.slice(0, 80)}", not your ChatGPT plan. Run: codex logout, then codex login`);
    else add("Codex login", "pass", out.slice(0, 120));
    if (opts.live === false) add("Codex live check", "warn", "skipped (--skip-live)");
    else if (flagsOk) {
      const r = await run(bin, [...pre, "exec", "--json", "-s", "read-only", "-c", 'approval_policy="never"', "--skip-git-repo-check", "-C", root, ...(me.model ? ["-m", me.model] : []), "-"], {
        input: "Reply with exactly: OK",
        timeoutMs: 180_000,
      });
      const ok = r.code === 0 && /"agent_message"[\s\S]*OK/.test(r.stdout);
      add("Codex live check", ok ? "pass" : "fail", ok ? "answered headless with no prompts" : `${r.timedOut ? "timed out" : "failed"}: ${(r.stderr || r.stdout).trim().slice(-300)}`);
    }
  } else add("agent", "warn", `adapter is "fake": no real agents will run (rehearsal)`);

  add(
    "usage cap",
    "pass",
    cfg.auth === "subscription"
      ? `subscriptions are not billed per use; a node still stops at about $${cfg.budget.node_usd} of estimated usage (team $${cfg.budget.team_usd}) and pauses on plan limits. ${cfg.concurrency} agents per Mac.`
      : `API billing: $${cfg.budget.node_usd} per node, $${cfg.budget.team_usd} team. ${cfg.concurrency} agents per Mac.`,
  );
  return out;
}

export function preflightOk(r: CheckResult[]): boolean {
  return !r.some((x) => x.status === "fail");
}
