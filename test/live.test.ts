// Opt-in: one real Claude task (about $0.20). Run with: RELAY_LIVE=1 npx vitest run test/live.test.ts
import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { RelayDaemon } from "../src/daemon.js";
import { makeTeam, NODES } from "./helpers.js";

it.skipIf(!process.env.RELAY_LIVE)("real Claude builds one task with no prompts", async () => {
  const team = makeTeam({
    nodes: [NODES[3]],
    tasks: [{ id: "HELLO", title: "Greeting module", lane: "core", lease: ["core/**"],
      brief: "Create core/greet.mjs exporting function greet(name) that returns `Hello, ${name}!`. Also create core/greet.test.mjs that imports it and exits non-zero (process.exit(1)) if greet('Ada') !== 'Hello, Ada!'. Before finishing, call record_assumption once about any detail you chose, and call check_board.",
      acceptance: ["node core/greet.test.mjs"] }],
    config: { adapter: "claude", models: { builder: "claude-sonnet-5-5", reviewer: "claude-haiku-5-5" }, budget: { node_usd: 1, team_usd: 1 },
      limits: { task_minutes: 8, max_turns: 30, stuck_minutes: 4, stale_claim_minutes: 5, heartbeat_seconds: 5, command_timeout_seconds: 60, retries: 1 },
      review: { enabled: true, max_rounds: 1 } },
  });
  const d = new RelayDaemon({ root: team.clones.aditri, node: "aditri", loopMs: 500 });
  await d.start();
  const events = d.ledger.all();
  console.log("denied:", events.filter((e) => e.kind === "agent_denied").map((e) => e.data?.text).slice(0, 5));
  console.log("tools:", events.filter((e) => e.kind === "agent_tool").map((e) => e.data?.tool).join(","));
  console.log("spent:", d.spentNode, "review:", JSON.stringify(events.find((e) => e.kind === "review")?.data));
  console.log(readFileSync(team.board, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).text.split("\n")[0]).join("\n"));
  expect(events.filter((e) => e.kind === "agent_denied")).toEqual([]);
  expect(team.git("ls-tree", "-r", "--name-only", "relay/2026-11-11")).toContain("core/greet.mjs");
}, 600_000);
