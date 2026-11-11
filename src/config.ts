// Schemas and loaders for the two files a team approves in the evening:
//   .nightshift/night.yaml  – standing pre-authorizations, nodes, limits, budget
//   .nightshift/tasks.yaml  – the task DAG with lanes and leases
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";

export const NodeSpec = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "node id: lowercase letters, digits, dashes"),
  name: z.string(), // shown in board posts: "[Ethan's Nightshift]"
  login: z.string().optional(), // GitHub login; preflight checks `gh` runs as this user
  lanes: z.array(z.string()).min(1),
});
export type NodeSpec = z.infer<typeof NodeSpec>;

export const BoardSpec = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("github"), repo: z.string().optional(), issue: z.number().int().positive() }),
  // A shared JSONL file. Used for tests and for single-Mac rehearsals.
  z.object({ kind: z.literal("file"), path: z.string() }),
]);
export type BoardSpec = z.infer<typeof BoardSpec>;

export const NightConfig = z.object({
  version: z.literal(1).default(1),
  project: z.string().default("project"),
  night: z.string().default("auto"), // "auto" → today's local date YYYY-MM-DD
  base_branch: z.string().default("main"),
  remote: z.string().default("origin"),
  board: BoardSpec,
  nodes: z.array(NodeSpec).min(1).max(8),
  // Evening pre-authorization. These record what humans decided before bed so
  // nothing overnight waits on them. Every field must be true to start a night.
  authorize: z.object({
    board_posts: z.boolean(),
    merge_to_night_branch: z.boolean(),
    work_stealing: z.boolean(),
    contract_changes: z.boolean(),
    decide_with_assumptions: z.boolean(),
  }),
  check: z.string().default(""), // global check after every task, e.g. "npm test"
  gate: z.object({ command: z.string(), every: z.number().int().min(1).default(3) }).optional(),
  concurrency: z.number().int().min(1).max(8).default(2),
  budget: z.object({ node_usd: z.number().positive().default(25), team_usd: z.number().positive().default(100) }).prefault({}),
  limits: z
    .object({
      task_minutes: z.number().positive().default(45),
      max_turns: z.number().int().positive().default(80),
      stuck_minutes: z.number().positive().default(10),
      stale_claim_minutes: z.number().positive().default(20),
      heartbeat_seconds: z.number().positive().default(60),
      command_timeout_seconds: z.number().positive().default(900),
      retries: z.number().int().min(0).default(1),
    })
    .prefault({}),
  models: z.object({ builder: z.string().optional(), reviewer: z.string().optional(), planner: z.string().optional() }).prefault({}),
  review: z.object({ enabled: z.boolean().default(true), max_rounds: z.number().int().min(1).default(2) }).prefault({}),
  steal: z.object({ never_lanes: z.array(z.string()).default([]), idle_seconds: z.number().min(0).default(30) }).prefault({}),
  contracts: z.array(z.string()).default([]),
  contract_lane: z.string().optional(), // lane whose node runs contract-change tasks
  // First word of every Bash command an agent may run. Anything else is denied (never asked).
  allow_commands: z.array(z.string()).default([]),
  poll_seconds: z.number().min(0.1).default(20),
  adapter: z.enum(["claude", "fake"]).default("claude"),
  dashboard_port: z.number().int().default(4545),
});
export type NightConfig = z.infer<typeof NightConfig>;

export const Task = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  title: z.string(),
  lane: z.string(),
  role: z.enum(["builder", "fixer", "contract"]).default("builder"),
  brief: z.string().default(""),
  lease: z.array(z.string()).min(1),
  depends_on: z.array(z.string()).default([]),
  contracts: z.array(z.string()).default([]),
  acceptance: z.array(z.string()).default([]),
  max_turns: z.number().int().positive().optional(),
  minutes: z.number().positive().optional(),
  // Only read by the fake adapter (tests and rehearsals).
  fake: z.record(z.string(), z.unknown()).optional(),
});
export type Task = z.infer<typeof Task>;

export const TaskFile = z.object({ tasks: z.array(Task) });

export const DEFAULT_ALLOW = [
  "ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "sed", "awk", "sort", "uniq", "diff", "echo", "printf",
  "pwd", "mkdir", "touch", "cp", "mv", "rm", "test", "true", "false", "which", "env", "jq", "tr", "cut", "xargs",
  "git", "node", "npm", "npx", "tsx", "tsc", "vitest", "python", "python3", "pip", "pytest", "uv", "ruff", "mypy",
  "make", "bash", "sh", "cd", "source", ".",
  // shell builtins
  "export", "set", "unset", "exit", "return", "wait", "shift", "type", "declare", "local", "readonly", ":", "[", "[[", "basename", "dirname", "realpath", "date", "sleep", "seq", "yes",
];

export interface Paths {
  root: string; // target repo checkout
  dir: string; // <root>/.nightshift
  local: string; // <root>/.nightshift/local (gitignored runtime state)
  night: string;
  tasks: string;
  idea: string;
}

export function paths(root: string): Paths {
  const dir = join(root, ".nightshift");
  return {
    root,
    dir,
    local: join(dir, "local"),
    night: join(dir, "night.yaml"),
    tasks: join(dir, "tasks.yaml"),
    idea: join(dir, "idea.md"),
  };
}

export function loadNight(root: string): NightConfig {
  const p = paths(root).night;
  if (!existsSync(p)) throw new Error(`missing ${p}. Run: nightshift init`);
  return NightConfig.parse(YAML.parse(readFileSync(p, "utf8")));
}

export function loadTasks(root: string): Task[] {
  const p = paths(root).tasks;
  if (!existsSync(p)) throw new Error(`missing ${p}. Run: nightshift plan, or write it by hand`);
  return validateTasks(TaskFile.parse(YAML.parse(readFileSync(p, "utf8"))).tasks);
}

/** Structural checks zod cannot express: unique ids, known deps, no cycles. */
export function validateTasks(tasks: Task[]): Task[] {
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) throw new Error(`duplicate task id ${t.id}`);
    ids.add(t.id);
  }
  for (const t of tasks) for (const d of t.depends_on) if (!ids.has(d)) throw new Error(`${t.id} depends on unknown ${d}`);
  const state = new Map<string, 0 | 1 | 2>();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visit = (id: string, stack: string[]) => {
    const s = state.get(id) ?? 0;
    if (s === 2) return;
    if (s === 1) throw new Error(`dependency cycle: ${[...stack, id].join(" -> ")}`);
    state.set(id, 1);
    for (const d of byId.get(id)!.depends_on) visit(d, [...stack, id]);
    state.set(id, 2);
  };
  for (const t of tasks) visit(t.id, []);
  return tasks;
}

/** Every authorize flag must be true, or a night would stall waiting for a person. */
export function missingAuthorizations(cfg: NightConfig): string[] {
  return Object.entries(cfg.authorize)
    .filter(([, v]) => !v)
    .map(([k]) => k);
}

export function nightName(cfg: NightConfig, now = new Date()): string {
  if (cfg.night !== "auto") return cfg.night;
  // A night that starts after midnight still belongs to the evening before.
  const d = new Date(now.getTime() - (now.getHours() < 6 ? 86_400_000 : 0));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const nightBranch = (night: string) => `night/${night}`;

export function findNode(cfg: NightConfig, id: string): NodeSpec {
  const n = cfg.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`node "${id}" is not in night.yaml (have: ${cfg.nodes.map((x) => x.id).join(", ")})`);
  return n;
}
