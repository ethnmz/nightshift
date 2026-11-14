// Subscription logins, Codex, and plan usage limits.
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RelayDaemon } from "../src/daemon.js";
import { CodexAdapter, parseResetTime } from "../src/agents/codex.js";
import { childEnv } from "../src/exec.js";
import { KEY_ENV } from "../src/config.js";
import { makeTeam, NODES } from "./helpers.js";

const FAKE_CODEX = join(fileURLToPath(new URL(".", import.meta.url)), "fake-codex.mjs");
const saved = { ...process.env };
afterEach(() => {
  for (const k of ["FAKE_CODEX", "RELAY_CODEX_BIN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("subscription logins", () => {
  it("API keys are removed from agent processes", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OPENAI_API_KEY = "sk-test";
    const env = childEnv({}, KEY_ENV);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(childEnv({}).ANTHROPIC_API_KEY).toBe("sk-ant-test"); // only agents are stripped
  });

  it("reads plan reset times from usage-limit messages", () => {
    const now = new Date(2026, 10, 11, 23, 0).getTime();
    expect(parseResetTime("You've hit your usage limit. Try again in 2 hours.", now)).toBe(now + 2 * 36e5);
    expect(new Date(parseResetTime("limit reached, try again at 3:05 AM", now)!).getHours()).toBe(3);
    expect(parseResetTime("something else", now)).toBeUndefined();
  });
});

describe("Codex nodes (stand-in codex binary, same flags and JSONL events)", () => {
  it("builds, uses the mailbox tools, gets reviewed and merged — headless, sandboxed, no API keys", async () => {
    process.env.RELAY_CODEX_BIN = FAKE_CODEX;
    process.env.OPENAI_API_KEY = "sk-should-not-reach-codex";
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-reach";
    process.env.FAKE_CODEX = JSON.stringify({
      writes: { "ai/model.py": "x = 1\n" },
      flags_file: "ai/flags.json",
      outbox: [
        { tool: "record_assumption", decision: "Use the small model", why: "brief is silent" },
        { tool: "ask", to: "lane:ai", question: "Which tokenizer?" },
      ],
    });
    const team = makeTeam({
      nodes: [{ ...NODES[2], agent: "codex" } as any],
      tasks: [{ id: "AI1", title: "Model wrapper", lane: "ai", lease: ["ai/**"], acceptance: ["test -f ai/model.py"] }],
      config: { adapter: "codex", auth: "subscription" },
    });
    const d = new RelayDaemon({ root: team.clones.akshi, node: "akshi", loopMs: 100 });
    expect(d.adapter).toBeInstanceOf(CodexAdapter);
    await d.start();
    const flags = JSON.parse(team.git("show", "relay/2026-11-11:ai/flags.json"));
    expect(flags).toEqual({ approval: true, sandbox: "workspace-write", apiKeys: [], pushurl: "file:///relay/agents-cannot-push" });
    const tree = team.git("ls-tree", "-r", "--name-only", "relay/2026-11-11");
    expect(tree).toContain("ai/model.py");
    expect(tree).not.toContain(".relay-mail"); // the mailbox never reaches a commit
    const board = readFileSync(team.board, "utf8");
    expect(board).toContain("Use the small model"); // mailbox → record_assumption
    expect(board).toContain('\\"type\\":\\"ask\\"');
    expect(board).toContain('\\"type\\":\\"answer\\"'); // read-only Codex answerer replied
    const review = d.ledger.all().find((e) => e.kind === "review");
    expect(review?.data?.verdict).toBe("approve"); // VERDICT line parsed from the read-only reviewer
  }, 60_000);

  it("a Codex usage limit is reported with its reset time", async () => {
    process.env.FAKE_CODEX = JSON.stringify({ limit: true });
    const team = makeTeam({ tasks: [], nodes: [NODES[2]] });
    const res = await new CodexAdapter(FAKE_CODEX).run({
      role: "builder", cwd: team.clones.akshi, system: "", prompt: "x", maxTurns: 1, timeoutMs: 20_000, stuckMs: 20_000,
      allowCommands: [], readOnly: false, inbox: () => [], onEvent: () => {}, tools: {} as any,
    });
    expect(res.reason).toBe("usage_limit");
    expect(res.resumeAt! - Date.now()).toBeGreaterThan(60_000);
  }, 30_000);
});

describe("plan usage limits during a run", () => {
  it("a node that hits its limit releases the task, pauses, and another node finishes it", async () => {
    const team = makeTeam({
      nodes: [NODES[0], NODES[3]],
      tasks: [{ id: "BIG", title: "Core task", lane: "core", lease: ["core/**"], fake: { usage_limit: "first", usage_limit_node: "aditri", reset_ms: 120_000, writes: { "core/a.txt": "a" } } }],
    });
    // Aditri's plan runs out first; Ethan's node has nothing in its lane and steals the released task.
    const aditri = new RelayDaemon({ root: team.clones.aditri, node: "aditri", loopMs: 100 });
    const ethan = new RelayDaemon({ root: team.clones.ethan, node: "ethan", loopMs: 100 });
    const pA = aditri.start();
    while (!aditri.paused()) await new Promise((r) => setTimeout(r, 50));
    await ethan.start();
    aditri.stop("test done");
    await pA;
    expect(team.git("ls-tree", "-r", "--name-only", "relay/2026-11-11")).toContain("core/a.txt");
    const board = readFileSync(team.board, "utf8");
    expect(board).toContain("Released BIG");
    expect(board).toMatch(/hit its usage limit\. Pausing until/);
    expect(ethan.merges).toBe(1);
    // A release is not a failure: nothing was parked.
    expect(board).not.toContain("Parked BIG");
  }, 60_000);
});
