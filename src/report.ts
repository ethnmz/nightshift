// The morning report: built only from shared, verifiable sources (git refs, the night
// branch, board envelopes). Nothing in it is inferred by a model.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadNight, loadTasks, nightBranch, nightName, paths, Task, NightConfig } from "./config.js";
import { Git } from "./git.js";
import { Claims } from "./claims.js";
import { makeBoard } from "./daemon.js";
import { readiness } from "./scheduler.js";
import type { BoardMessage, Envelope } from "./board/envelope.js";
import { run } from "./exec.js";

export interface ReportData {
  markdown: string;
  file: string;
}

const esc = (s: unknown) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").slice(0, 400);

export async function buildReport(root: string, nodeId: string, night?: string): Promise<ReportData> {
  const cfg: NightConfig = loadNight(root);
  const n = night ?? nightName(cfg);
  const branch = nightBranch(n);
  const git = new Git(root);
  const claims = new Claims(git, cfg.remote, n);
  const states = await claims.list();
  const dyn = (await claims.listTasks()).map((x) => Task.parse(x));
  const tasks = [...loadTasks(root), ...dyn.filter((d) => !loadTasks(root).some((t) => t.id === d.id))];
  await git.raw(["fetch", "--quiet", cfg.remote, `+refs/heads/${branch}:refs/remotes/${cfg.remote}/${branch}`, `+refs/heads/${cfg.base_branch}:refs/remotes/${cfg.remote}/${cfg.base_branch}`]);
  const log = (await git.raw(["log", "--format=%h%x09%s%x09%(trailers:key=Nightshift-Node,valueonly,separator=)", `refs/remotes/${cfg.remote}/${cfg.base_branch}..refs/remotes/${cfg.remote}/${branch}`])).stdout.trim();
  const stat = (await git.raw(["diff", "--shortstat", `refs/remotes/${cfg.remote}/${cfg.base_branch}...refs/remotes/${cfg.remote}/${branch}`])).stdout.trim();

  const board = makeBoard(cfg, root, join(paths(root).local, nodeId, "report-cursor-unused"));
  let msgs: BoardMessage[] = [];
  try {
    msgs = await board.fetchAll();
  } catch {
    /* report still works from git alone */
  }
  const envs = msgs.map((m) => m.env).filter((e): e is Envelope => !!e && (!e.night || e.night === n));
  const by = (type: string) => envs.filter((e) => e.type === type);
  const spent = new Map<string, number>();
  for (const e of envs) if (typeof e.body.spent === "number") spent.set(e.from, Math.max(spent.get(e.from) ?? 0, e.body.spent as number));
  const r = readiness(tasks, states, () => false);
  const count = (k: string) => [...r.values()].filter((x) => x === k).length;
  const started = by("node_up").map((e) => e.at);
  const ended = by("node_down").map((e) => e.at);
  const fmt = (t?: number) => (t ? new Date(t).toLocaleString() : "?");

  const L: string[] = [];
  L.push(`# Nightshift report: ${cfg.project}, night ${n}`, "");
  L.push(`**${count("done")}/${tasks.length} tasks merged** into \`${branch}\` · ${count("parked")} parked · ${count("blocked")} blocked by parked work · ${count("running") + count("stale")} unfinished · ${count("ready") + count("waiting")} not started`);
  L.push(`Started ${fmt(Math.min(...started))}, last node finished ${fmt(ended.length ? Math.max(...ended) : undefined)}. Diff vs \`${cfg.base_branch}\`: ${stat || "none"}.`);
  L.push(`Estimated model spend: ${[...spent].map(([k, v]) => `${k} $${v.toFixed(2)}`).join(", ") || "n/a"} (team $${[...spent.values()].reduce((a, b) => a + b, 0).toFixed(2)} of $${cfg.budget.team_usd}).`);
  L.push("", "> Merging to `" + cfg.base_branch + "` is a human decision. Read *Decisions to review* first.", "");

  const assumptions = by("assumption");
  L.push(`## Decisions to review (${assumptions.length})`, "", "Agents made these without a human. Each is a place the product may differ from what you meant.", "");
  if (assumptions.length) {
    L.push("| Task | Node | Decision | Why |", "|---|---|---|---|");
    for (const e of assumptions) L.push(`| ${esc(e.task)} | ${e.from} | ${esc(e.body.decision)} | ${esc(e.body.why)} |`);
  } else L.push("(none recorded)");

  const parked = tasks.filter((t) => r.get(t.id) === "parked");
  L.push("", `## Parked tasks (${parked.length})`, "");
  for (const t of parked) {
    const s = states.get(t.id)!.state;
    const p = by("task_parked").filter((e) => e.task === t.id).pop();
    L.push(`- **${t.id}** ${t.title} (lane ${t.lane}, ${s.node}, attempt ${s.attempt}): ${esc(s.note)}${p?.body.branch ? `. Work kept on \`${p.body.branch}\`` : ""}`);
  }
  if (!parked.length) L.push("(none)");
  const blocked = tasks.filter((t) => r.get(t.id) === "blocked");
  if (blocked.length) L.push("", `Blocked behind parked work: ${blocked.map((t) => t.id).join(", ")}`);
  const unfinished = tasks.filter((t) => !["done", "parked", "blocked"].includes(r.get(t.id)!));
  if (unfinished.length) L.push("", `Unfinished (budget, stop, or time ran out): ${unfinished.map((t) => `${t.id} (${r.get(t.id)})`).join(", ")}`);

  const issues = [...by("blocker"), ...by("contract_change"), ...by("lease_request"), ...by("gate_failed")];
  L.push("", `## Cross-team issues (${issues.length})`, "");
  for (const e of issues) L.push(`- ${e.type} from ${e.from}${e.task ? "/" + e.task : ""} → ${e.to}: ${esc(e.body.text ?? e.body.reason ?? e.body.detail ?? "")}`);
  if (!issues.length) L.push("(none)");
  const gates = [...by("gate_passed"), ...by("gate_failed")].sort((a, b) => a.at - b.at);
  if (gates.length) L.push("", `Integration gate: last result **${gates[gates.length - 1].type === "gate_passed" ? "passed" : "FAILED"}** (${gates.length} runs).`);

  const asks = by("ask");
  if (asks.length) {
    L.push("", `## Questions agents asked each other (${asks.length})`, "");
    for (const q of asks) {
      const a = by("answer").find((x) => x.body.question_id === q.body.question_id);
      L.push(`- ${q.from}/${q.task} → ${q.to}: ${esc(q.body.question)}${a ? `\n  - answer (${a.from}): ${esc(a.body.text)}` : "\n  - no answer (the asker continued with an assumption)"}`);
    }
  }

  L.push("", "## Merged commits", "", "```", log || "(none)", "```", "", "## All tasks", "", "| Task | Lane | Status | Node | Note |", "|---|---|---|---|---|");
  for (const t of tasks) {
    const s = states.get(t.id)?.state;
    L.push(`| ${t.id} ${esc(t.title)} | ${t.lane} | ${r.get(t.id)} | ${s?.node ?? ""} | ${esc(s?.note ?? (s?.merge ? s.merge.slice(0, 8) : ""))} |`);
  }
  L.push("", "_Generated by Nightshift from git refs, the night branch and board envelopes. Acknowledging this report does not mean the code was reviewed by a human._");

  const dir = join(paths(root).local, "reports");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${n}.md`);
  writeFileSync(file, L.join("\n") + "\n");
  return { markdown: L.join("\n") + "\n", file };
}

/** Opens the single morning PR (night → base). The human merges it. */
export async function openMorningPr(root: string, report: ReportData, night?: string): Promise<string> {
  const cfg = loadNight(root);
  const n = night ?? nightName(cfg);
  const r = await run("gh", ["pr", "create", "--base", cfg.base_branch, "--head", nightBranch(n), "--title", `Nightshift: night of ${n}`, "--body-file", report.file], { cwd: root, timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(r.stderr.trim());
  return r.stdout.trim();
}
