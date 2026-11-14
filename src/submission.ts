// Submission kit: the lead's agent reads the finished run branch (read-only) and
// drafts How to run, a demo script, what works vs. what's mocked, and a Devpost write-up.
// Committing SUBMISSION.md to the run branch happens only when a person clicks it.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, loadTasks, paths, runBranch, agentFor, findNode, KEY_ENV, DEFAULT_ALLOW, Task } from "./config.js";
import { Git } from "./git.js";
import { Claims } from "./claims.js";
import { makeBoard } from "./daemon.js";
import { loadSetup, rolesOf } from "./setup.js";
import { prompt } from "./prompts.js";
import { ClaudeAdapter } from "./agents/claude.js";
import { CodexAdapter } from "./agents/codex.js";
import { FakeAdapter } from "./agents/fake.js";
import type { Adapter, RelayTools } from "./agents/types.js";

const noTools: RelayTools = {
  post_note: async () => "not available",
  ask: async () => "not available",
  answer: async () => "not available",
  check_board: async () => "No messages.",
  record_assumption: async () => "noted",
  report_blocker: async () => "noted",
  request_contract_change: async () => "not available",
  submit_review: async () => "not available",
};

async function runWorktree(root: string, node: string, runId: string): Promise<{ git: Git; wt: string; head: string }> {
  const cfg = loadConfig(root);
  const git = new Git(root, { name: "Relay", email: `${node}@relay.local` });
  const ref = `refs/remotes/${cfg.remote}/${runBranch(runId)}`;
  const f = await git.raw(["fetch", "--quiet", "--no-tags", cfg.remote, `+refs/heads/${runBranch(runId)}:${ref}`]);
  if (f.code !== 0) throw new Error(`There is no ${runBranch(runId)} branch yet. Run a run first.`);
  const head = (await git.revParse(ref))!;
  const wt = join(paths(root).local, node, "wt", "_submission");
  await git.raw(["worktree", "remove", "--force", wt]);
  rmSync(wt, { recursive: true, force: true });
  await git.raw(["worktree", "prune"]);
  await git.ok(["worktree", "add", "--quiet", "--detach", wt, head]);
  return { git, wt, head };
}

export async function draftSubmission(root: string, node: string, runId: string, adapterOverride?: Adapter): Promise<{ markdown: string; sections: { title: string; body: string }[] }> {
  const cfg = loadConfig(root);
  const me = findNode(cfg, node);
  const setup = loadSetup(root);
  const { git, wt } = await runWorktree(root, node, runId);
  try {
    const claims = new Claims(git, cfg.remote, runId);
    const states = await claims.list();
    const dyn = (await claims.listTasks()).map((x) => Task.parse(x));
    const tasks = [...loadTasks(root), ...dyn];
    const merged = tasks.filter((t) => states.get(t.id)?.state.status === "done");
    const parked = tasks.filter((t) => states.get(t.id)?.state.status === "parked");
    let decisions: string[] = [];
    try {
      const msgs = await makeBoard(cfg, root, join(paths(root).local, node, "submission-cursor")).fetchAll();
      decisions = msgs.filter((m) => m.env?.type === "assumption" && m.env.runId === runId).map((m) => `- ${String(m.env!.body.decision)}`);
    } catch {
      /* the board is optional here */
    }
    const idea = existsSync(paths(root).idea) ? readFileSync(paths(root).idea, "utf8").slice(0, 20_000) : "";
    const kind = agentFor(cfg, me);
    const adapter: Adapter = adapterOverride ?? (kind === "fake" ? new FakeAdapter(node) : kind === "codex" ? new CodexAdapter() : new ClaudeAdapter());
    const res = await adapter.run({
      role: "writer",
      cwd: wt,
      system: "You write a hackathon submission from a finished codebase. Be accurate: only describe what the code actually does. Never invent results, users or metrics.",
      prompt: prompt("submission", {
        event: setup.event.name || cfg.project,
        idea,
        demo: setup.idea.demo || "(not given)",
        merged: merged.map((t) => `- ${t.id}: ${t.title}`).join("\n") || "(none)",
        parked: parked.map((t) => `- ${t.id}: ${t.title}`).join("\n") || "(none)",
        decisions: decisions.join("\n") || "(none recorded)",
        check: cfg.check || "(none)",
        team: setup.team.map((m) => `- ${m.name}: ${rolesOf(m).join(", ")}`).join("\n"),
      }),
      model: me.model ?? (kind === "claude" ? cfg.models.planner : undefined),
      maxTurns: 40,
      timeoutMs: 15 * 60_000,
      stuckMs: 6 * 60_000,
      allowCommands: cfg.allow_commands.length ? cfg.allow_commands : DEFAULT_ALLOW,
      readOnly: true,
      removeEnv: cfg.auth === "subscription" ? KEY_ENV : [],
      tools: noTools,
      inbox: () => [],
      onEvent: () => {},
    });
    if (!res.ok || !res.text.trim()) throw new Error(`The agent could not write the draft (${res.reason ?? "no output"}).`);
    const markdown = res.text.trim();
    const sections = markdown
      .split(/\n(?=## )/)
      .map((chunk) => {
        const m = /^## (.+)\n?([\s\S]*)$/.exec(chunk.trim());
        return m ? { title: m[1].trim(), body: m[2].trim() } : null;
      })
      .filter((x): x is { title: string; body: string } => !!x);
    return { markdown, sections };
  } finally {
    await git.raw(["worktree", "remove", "--force", wt]);
  }
}

/** A person clicked "Add to the pull request": commit SUBMISSION.md onto the run branch. */
export async function commitSubmission(root: string, node: string, runId: string, markdown: string): Promise<string> {
  const cfg = loadConfig(root);
  for (let attempt = 0; attempt < 4; attempt++) {
    const { git: rootGit, wt } = await runWorktree(root, node, runId);
    try {
      const g = new Git(wt, { name: "Relay (submission)", email: `${node}@relay.local` });
      mkdirSync(wt, { recursive: true });
      writeFileSync(join(wt, "SUBMISSION.md"), markdown.endsWith("\n") ? markdown : markdown + "\n");
      if (!(await g.commitAll("Add SUBMISSION.md (README, demo script, Devpost draft)"))) return "unchanged";
      const p = await g.raw(["push", "--quiet", cfg.remote, `HEAD:refs/heads/${runBranch(runId)}`]);
      if (p.code === 0) return await g.ok(["rev-parse", "HEAD"]);
    } finally {
      await rootGit.raw(["worktree", "remove", "--force", wt]);
    }
  }
  throw new Error("Could not push SUBMISSION.md (the run branch kept moving). Try again.");
}
