// Schemas and loaders for the two files a team approves before a run:
//   .relay/relay.yaml  – standing pre-authorizations, nodes, limits, budget
//   .relay/tasks.yaml  – the task DAG with lanes and leases
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";

export const NodeSpec = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "node id: lowercase letters, digits, dashes"),
  name: z.string(), // shown in board posts: "[Ethan's Relay]"
  login: z.string().optional(), // GitHub login; preflight checks `gh` runs as this user
  lanes: z.array(z.string()).min(1),
  // Which coding agent this teammate's Mac runs, on their own subscription login.
  agent: z.enum(["claude", "codex"]).optional(),
  model: z.string().optional(), // per-teammate model override
});
export type NodeSpec = z.infer<typeof NodeSpec>;

export const BoardSpec = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("github"), repo: z.string().optional(), issue: z.number().int().positive().optional() }), // issue is created by "Share with team"
  // A shared JSONL file. Used for tests and for single-Mac rehearsals.
  z.object({ kind: z.literal("file"), path: z.string() }),
]);
export type BoardSpec = z.infer<typeof BoardSpec>;

export const RelayConfig = z.object({
  version: z.literal(1).default(1),
  project: z.string().default("project"),
  // Which run this plan belongs to. "Share with the team" writes a new id (YYYY-MM-DD-HHMM) each time
  // the plan changes, so every computer agrees on it without asking. "auto" → today's date.
  run_id: z.string().default("auto"),
  base_branch: z.string().default("main"),
  remote: z.string().default("origin"),
  board: BoardSpec,
  nodes: z.array(NodeSpec).min(1).max(8),
  // Standing pre-authorization. These record what humans decided before the run so
  // nothing during it waits on them. Every field must be true to start a run.
  authorize: z.object({
    board_posts: z.boolean(),
    merge_to_run_branch: z.boolean(),
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
  adapter: z.enum(["claude", "codex", "fake"]).default("claude"), // default agent; nodes[].agent overrides
  // "subscription": agents use each teammate's own Claude Code / Codex login (Pro/Max/Team or
  // ChatGPT plan). API keys are removed from the agents' environment so nothing bills a key.
  // "api_key": allow ANTHROPIC_API_KEY / OPENAI_API_KEY (pay per use).
  auth: z.enum(["subscription", "api_key"]).default("subscription"),
  // On a usage-limit hit: release the task to other nodes and pause this node until the limit resets.
  usage_limit_pause_minutes: z.number().positive().default(30), // used when no reset time is reported
  // Submission deadline (local ISO, e.g. 2027-11-14T10:00). No new tasks start after
  // deadline − stop_before_minutes; work in progress still finishes.
  deadline: z.string().optional(),
  stop_before_minutes: z.number().min(0).default(120),
  // Alerts reach the lead through a GitHub @mention on the team board (GitHub's own phone notifications).
  alerts: z
    .object({
      enabled: z.boolean().default(true),
      mention: z.string().optional(), // GitHub login to @mention
      finished: z.boolean().default(true), // also notify when the run is finished
    })
    .prefault({}),
  status_every_minutes: z.number().positive().default(10), // live progress comment refresh
  dashboard_port: z.number().int().default(4545),
});
export type RelayConfig = z.infer<typeof RelayConfig>;

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
  // must = demo-critical (built first); nice = only if there is time and usage left.
  priority: z.enum(["must", "nice"]).default("must"),
  retry_of: z.string().optional(), // a retry of a parked task
  max_turns: z.number().int().positive().optional(),
  minutes: z.number().positive().optional(),
  // Only read by the fake adapter (tests and rehearsals).
  fake: z.record(z.string(), z.unknown()).optional(),
});
export type Task = z.infer<typeof Task>;

export const TaskFile = z.object({
  tasks: z.array(Task),
  // Optional suggestions from the planner, adopted into relay.yaml if the team set none.
  check: z.string().optional(),
  gate: z.object({ command: z.string(), every: z.number().optional() }).optional(),
  contracts: z.array(z.string()).optional(),
});

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
  dir: string; // <root>/.relay
  local: string; // <root>/.relay/local (gitignored runtime state)
  config: string; // <root>/.relay/relay.yaml
  tasks: string;
  idea: string;
}

export function paths(root: string): Paths {
  const dir = join(root, ".relay");
  return {
    root,
    dir,
    local: join(dir, "local"),
    config: join(dir, "relay.yaml"),
    tasks: join(dir, "tasks.yaml"),
    idea: join(dir, "idea.md"),
  };
}

export function loadConfig(root: string): RelayConfig {
  const p = paths(root).config;
  if (!existsSync(p)) throw new Error(`missing ${p}. Run: relay init`);
  return RelayConfig.parse(YAML.parse(readFileSync(p, "utf8")));
}

export function loadTasks(root: string): Task[] {
  const p = paths(root).tasks;
  if (!existsSync(p)) throw new Error(`missing ${p}. Run: relay plan, or write it by hand`);
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

/** Every authorize flag must be true, or a run would stall waiting for a person. */
export function missingAuthorizations(cfg: RelayConfig): string[] {
  return Object.entries(cfg.authorize)
    .filter(([, v]) => !v)
    .map(([k]) => k);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A fresh run id from the clock, e.g. 2026-11-14-1930. Sorts in start order. */
export function newRunId(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** The run this plan belongs to. Time of day does not matter: the id comes from relay.yaml. */
export function runName(cfg: RelayConfig, now = new Date()): string {
  if (cfg.run_id !== "auto") return cfg.run_id;
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export const runBranch = (runId: string) => `relay/${runId}`;

export function agentFor(cfg: RelayConfig, node: NodeSpec): "claude" | "codex" | "fake" {
  if (cfg.adapter === "fake") return "fake";
  return node.agent ?? (cfg.adapter as "claude" | "codex");
}

/** Env vars that would make an agent bill an API key instead of the teammate's subscription. */
export const KEY_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "OPENAI_API_KEY", "CODEX_API_KEY"];

export function findNode(cfg: RelayConfig, id: string): NodeSpec {
  const n = cfg.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`node "${id}" is not in relay.yaml (have: ${cfg.nodes.map((x) => x.id).join(", ")})`);
  return n;
}
