// The onboarding wizard's data model. The UI edits `.relay/setup.json` (plain answers:
// hackathon context, team, rules); this module turns it into the files the run runs on:
// `.relay/idea.md` (for the planner and every agent) and `.relay/relay.yaml`.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { paths, RelayConfig } from "./config.js";

export const Member = z.object({
  id: z.string().default(""), // stable slug, e.g. "ethan"; generated from the name on save
  name: z.string().min(1),
  github: z.string().default(""),
  os: z.enum(["mac", "windows", "linux"]).default("mac"),
  agent: z.enum(["claude", "codex"]).default("claude"),
  roles: z.string().default(""), // comma-separated, e.g. "frontend, demo"
  model: z.string().optional(),
});
export type Member = z.infer<typeof Member>;

export const Setup = z.object({
  version: z.literal(1).default(1),
  event: z
    .object({
      name: z.string().default(""),
      track: z.string().default(""), // challenge / sponsor track text, pasted
      deadline: z.string().default(""), // ISO local datetime
      links: z.string().default(""),
    })
    .prefault({}),
  idea: z
    .object({
      pitch: z.string().default(""), // one or two sentences
      problem: z.string().default(""),
      demo: z.string().default(""), // what the demo must show, in order
      must: z.string().default(""),
      nice: z.string().default(""),
      stack: z.string().default(""),
      rules: z.string().default(""), // rules agents must follow
    })
    .prefault({}),
  team: z.array(Member).default([]),
  rules: z
    .object({
      perComputer: z.number().int().min(1).max(6).default(2),
      usageCap: z.number().positive().default(25), // estimated $ per computer per run
      review: z.boolean().default(true),
      stealing: z.boolean().default(true),
      contractsOwner: z.string().default(""), // member id who applies contract changes
      check: z.string().default(""), // how we know the build works; planner suggests one if empty
      alerts: z.boolean().default(true), // @mention the lead on GitHub for real problems
      stopBefore: z.number().min(0).default(120), // minutes before the deadline to stop starting new work
    })
    .prefault({}),
});
export type Setup = z.infer<typeof Setup>;

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30) || "x";

export function rolesOf(m: Member): string[] {
  const r = m.roles
    .split(/[,/]/)
    .map((x) => slug(x.trim()))
    .filter((x) => x && x !== "x");
  return r.length ? r : [slug(m.name)];
}

export function setupFile(root: string) {
  return join(paths(root).dir, "setup.json");
}

export function loadSetup(root: string): Setup {
  const f = setupFile(root);
  if (!existsSync(f)) return Setup.parse({});
  return Setup.parse(JSON.parse(readFileSync(f, "utf8")));
}

export function ideaMarkdown(s: Setup): string {
  const sec = (h: string, b: string) => (b.trim() ? `## ${h}\n${b.trim()}\n` : "");
  const team = s.team.map((m) => `- ${m.name}${m.github ? ` (@${m.github})` : ""}: ${rolesOf(m).join(", ")} · ${m.os} · ${m.agent === "codex" ? "Codex" : "Claude Code"}`).join("\n");
  return [
    `# ${s.event.name || "Hackathon project"}${s.idea.pitch ? `\n\n${s.idea.pitch.trim()}` : ""}\n`,
    sec("Challenge / track", s.event.track),
    s.event.deadline ? `## Deadline\n${s.event.deadline}\n` : "",
    sec("Problem and users", s.idea.problem),
    sec("What the demo must show (in order)", s.idea.demo),
    sec("Must-haves", s.idea.must),
    sec("Nice-to-haves", s.idea.nice),
    sec("Tech stack", s.idea.stack),
    sec("Rules every agent must follow", s.idea.rules),
    `## Team and roles\n${team}\n`,
    sec("Links", s.event.links),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Build relay.yaml from the wizard answers, keeping advanced fields someone edited by hand. */
export function configYaml(s: Setup, root: string, existing?: Partial<RelayConfig>): Record<string, unknown> {
  const nodes = s.team.map((m) => ({
    id: m.id,
    name: m.name,
    ...(m.github ? { login: m.github } : {}),
    lanes: rolesOf(m),
    agent: m.agent,
    ...(m.model ? { model: m.model } : {}),
  }));
  const owner = s.team.find((m) => m.id === s.rules.contractsOwner) ?? s.team[0];
  const prevBoard = existing?.board as { kind?: string; issue?: number; repo?: string; path?: string } | undefined;
  const board = prevBoard?.kind === "file" ? prevBoard : { kind: "github", ...(prevBoard?.repo ? { repo: prevBoard.repo } : {}), ...(prevBoard?.issue ? { issue: prevBoard.issue } : {}) };
  const team = Math.max(1, s.team.length);
  return {
    ...(existing ?? {}),
    version: 1,
    project: slug(s.event.name || root.split(/[\\/]/).pop() || "project"),
    run_id: existing?.run_id ?? "auto",
    base_branch: existing?.base_branch ?? "main",
    remote: existing?.remote ?? "origin",
    board,
    nodes,
    // The wizard's "Rules" step is where the team grants these in plain words.
    authorize: {
      board_posts: true,
      merge_to_run_branch: true,
      work_stealing: s.rules.stealing,
      contract_changes: true,
      decide_with_assumptions: true,
    },
    check: s.rules.check || existing?.check || "",
    ...(existing?.gate ? { gate: existing.gate } : {}),
    concurrency: s.rules.perComputer,
    budget: { node_usd: s.rules.usageCap, team_usd: Math.round(s.rules.usageCap * team) },
    review: { enabled: s.rules.review, max_rounds: 2 },
    contracts: existing?.contracts ?? [],
    contract_lane: owner ? rolesOf(owner)[0] : undefined,
    auth: existing?.auth ?? "subscription",
    ...(s.event.deadline ? { deadline: s.event.deadline } : {}),
    stop_before_minutes: s.rules.stopBefore,
    alerts: { enabled: s.rules.alerts, ...(s.team[0]?.github ? { mention: s.team[0].github } : {}), finished: true },
    adapter: existing?.adapter ?? "claude",
  };
}

export function saveSetup(root: string, s: Setup): { config: string; idea: string } {
  const p = paths(root);
  mkdirSync(p.dir, { recursive: true });
  // Give every member a unique id.
  const seen = new Set<string>();
  for (const m of s.team) {
    let id = m.id && m.id !== "x" ? slug(m.id) : slug(m.name);
    while (seen.has(id)) id += "2";
    seen.add(id);
    m.id = id;
  }
  // The contracts owner may arrive as a name (from a brief); store the member id.
  const o = s.rules.contractsOwner.trim().toLowerCase();
  if (o && !s.team.some((m) => m.id === o)) {
    const hit = s.team.find((m) => m.name.toLowerCase() === o) ?? s.team.find((m) => m.name.toLowerCase().split(" ")[0] === o.split(" ")[0]);
    s.rules.contractsOwner = hit?.id ?? "";
  }
  writeFileSync(setupFile(root), JSON.stringify(s, null, 2) + "\n");
  let idea = ideaMarkdown(s);
  // Keep the team's whole brief for the planner, so nothing the form could not hold is lost.
  const brief = join(p.dir, "brief.md");
  if (existsSync(brief)) {
    const text = readFileSync(brief, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim();
    if (text) idea += `\n## The team's original brief\n\n${text.slice(0, 40_000)}\n`;
  }
  writeFileSync(p.idea, idea);
  const existing = existsSync(p.config) ? (YAML.parse(readFileSync(p.config, "utf8")) as Partial<RelayConfig>) : undefined;
  const config = YAML.stringify(configYaml(s, root, existing));
  writeFileSync(p.config, config);
  if (!existsSync(p.tasks)) writeFileSync(p.tasks, "tasks: []\n");
  const gi = join(root, ".gitignore");
  if (!existsSync(gi) || !readFileSync(gi, "utf8").includes(".relay/local/")) appendFileSync(gi, "\n.relay/local/\n");
  return { config, idea };
}

/** After planning: adopt the planner's suggested check/gate if the team did not set one. */
export function adoptPlannerChecks(root: string) {
  const p = paths(root);
  const tf = YAML.parse(readFileSync(p.tasks, "utf8")) ?? {};
  const doc = YAML.parse(readFileSync(p.config, "utf8")) ?? {};
  let changed = false;
  if (!doc.check && typeof tf.check === "string") {
    doc.check = tf.check;
    changed = true;
  }
  if (!doc.gate && tf.gate?.command) {
    doc.gate = { command: String(tf.gate.command), every: Number(tf.gate.every ?? 3) };
    changed = true;
  }
  if (Array.isArray(tf.contracts) && !(doc.contracts ?? []).length) {
    doc.contracts = tf.contracts;
    changed = true;
  }
  if (changed) writeFileSync(p.config, YAML.stringify(doc));
}
