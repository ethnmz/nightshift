// Evening step: idea.md → contracts, stubs, fixtures and tasks.yaml. The team reviews the
// result (dashboard or editor) before anyone starts the night.
import { existsSync, readFileSync } from "node:fs";
import YAML from "yaml";
import { loadNight, paths, TaskFile, validateTasks, DEFAULT_ALLOW, KEY_ENV } from "./config.js";
import { CodexAdapter } from "./agents/codex.js";
import { ClaudeAdapter } from "./agents/claude.js";
import { prompt } from "./prompts.js";
import type { NightshiftTools } from "./agents/types.js";

export async function plan(root: string, log: (s: string) => void = console.log, agent: "claude" | "codex" = "claude"): Promise<{ ok: boolean; tasks: number; cost: number; errors?: string }> {
  const cfg = loadNight(root);
  const p = paths(root);
  if (!existsSync(p.idea)) throw new Error(`write the idea first: ${p.idea}`);
  const assumptions: string[] = [];
  const tools: NightshiftTools = {
    post_note: async () => "noted",
    ask: async () => "No one to ask while planning. Decide, then record_assumption.",
    answer: async () => "ok",
    check_board: async () => "No messages.",
    record_assumption: async ({ decision, why }) => {
      assumptions.push(`${decision} — ${why}`);
      log(`assumption: ${decision}`);
      return "recorded";
    },
    report_blocker: async ({ detail }) => {
      log(`blocker: ${detail}`);
      return "noted";
    },
    request_contract_change: async () => "You are writing the contracts; edit them directly.",
    submit_review: async () => "n/a",
  };
  const nodes = cfg.nodes.map((n) => `- ${n.name} (${n.id}): lanes ${n.lanes.join(", ")}`).join("\n");
  const adapter = agent === "codex" ? new CodexAdapter() : new ClaudeAdapter();
  let cost = 0;
  let errors = "";
  for (let round = 1; round <= 2; round++) {
    const res = await adapter.run({
      role: "planner",
      cwd: root,
      system: `You are planning an overnight build for ${cfg.project}. Humans are available only until the plan is approved; do not ask them anything during this run.`,
      prompt:
        round === 1
          ? prompt("planner", { node_count: cfg.nodes.length, nodes })
          : `.nightshift/tasks.yaml is invalid:\n${errors}\nFix it (same schema) and keep everything else.`,
      model: agent === "claude" ? cfg.models.planner : undefined,
      removeEnv: cfg.auth === "subscription" ? KEY_ENV : [],
      maxTurns: 120,
      timeoutMs: 40 * 60_000,
      stuckMs: 10 * 60_000,
      allowCommands: cfg.allow_commands.length ? cfg.allow_commands : DEFAULT_ALLOW,
      readOnly: false,
      tools,
      inbox: () => [],
      onEvent: (e) => {
        if (e.kind === "tool") log(`  ${e.tool} ${JSON.stringify(e.input).slice(0, 120)}`);
        if (e.kind === "denied") log(`  denied: ${e.text?.slice(0, 160)}`);
      },
    });
    cost += res.costUsd;
    try {
      const parsed = TaskFile.parse(YAML.parse(readFileSync(p.tasks, "utf8")));
      validateTasks(parsed.tasks);
      const lanes = new Set(cfg.nodes.flatMap((n) => n.lanes));
      const bad = parsed.tasks.filter((t) => !lanes.has(t.lane));
      if (bad.length) throw new Error(`tasks use lanes no node owns: ${bad.map((t) => `${t.id}:${t.lane}`).join(", ")}`);
      return { ok: true, tasks: parsed.tasks.length, cost };
    } catch (e) {
      errors = String(e).slice(0, 4000);
      log(`tasks.yaml invalid: ${errors}`);
    }
  }
  return { ok: false, tasks: 0, cost, errors };
}
