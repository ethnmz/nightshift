import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { NightDaemon } from "../src/daemon.js";
import { FakeAdapter } from "../src/agents/fake.js";
import { makeTeam, NODES } from "./helpers.js";

const LANES: Record<string, string> = { frontend: "web", voice: "voice", ai: "ai", core: "core" };

function baseTasks() {
  const tasks: any[] = [
    { id: "T0", title: "Scaffold", lane: "core", lease: ["core/**"], acceptance: ["test -f core/scaffold.txt"], fake: { writes: { "core/scaffold.txt": "scaffold" } } },
  ];
  for (const [lane, dir] of Object.entries(LANES)) {
    for (let i = 1; i <= 2; i++) {
      tasks.push({
        id: `${lane}-${i}`,
        title: `${lane} piece ${i}`,
        lane,
        depends_on: ["T0"],
        lease: [`${dir}/${i}/**`],
        acceptance: [`test -f ${dir}/${i}/out.txt`],
        fake: { writes: { [`${dir}/${i}/out.txt`]: `${lane} ${i}` }, sleep_ms: 150 },
      });
    }
  }
  return tasks;
}

const run4 = (team: ReturnType<typeof makeTeam>, adapters?: Record<string, FakeAdapter>) =>
  NODES.map((n) => new NightDaemon({ root: team.clones[n.id], node: n.id, loopMs: 100, adapter: adapters?.[n.id] }));

describe("4-node night with the fake adapter", () => {
  it("builds every task exactly once and merges all of it into the night branch", async () => {
    const team = makeTeam({
      tasks: [
        ...baseTasks(),
        { id: "LEASE", title: "Writes outside its lease", lane: "ai", depends_on: ["T0"], lease: ["ai/x/**"], acceptance: ["test -f ai/x/ok.txt"], fake: { writes: { "ai/x/ok.txt": "ok", "web/1/hack.txt": "nope" }, assume: "picked the default model", ask: { to: "lane:core", question: "Is owner_id nullable?" } } },
        { id: "FLAKY", title: "Fails once then passes", lane: "voice", depends_on: ["T0"], lease: ["voice/flaky/**"], fake: { fail: "first", writes: { "voice/flaky/a.txt": "a" } } },
        { id: "REVIEWED", title: "Reviewer asks once", lane: "frontend", depends_on: ["T0"], lease: ["web/rev/**"], fake: { review: "changes-once", writes: { "web/rev/a.txt": "a" } } },
        { id: "BAD", title: "Never passes acceptance", lane: "core", depends_on: ["T0"], lease: ["core/bad/**"], acceptance: ["false"], fake: { writes: { "core/bad/a.txt": "a" } } },
        { id: "AFTERBAD", title: "Depends on a parked task", lane: "core", depends_on: ["BAD"], lease: ["core/after/**"], fake: { writes: { "core/after/a.txt": "a" } } },
      ],
    });
    const daemons = run4(team);
    await Promise.all(daemons.map((d) => d.start()));

    const log = team.git("log", "--format=%s", "night/2026-11-11");
    const merged = log.split("\n").filter((s) => /^[\w-]+: /.test(s)).map((s) => s.split(":")[0]);
    const expected = ["T0", ...Object.keys(LANES).flatMap((l) => [`${l}-1`, `${l}-2`]), "LEASE", "FLAKY", "REVIEWED"];
    expect(merged.sort()).toEqual(expected.sort()); // each exactly once
    expect(merged).not.toContain("BAD");
    expect(merged).not.toContain("AFTERBAD");

    // Lease enforcement: the out-of-lease file never reached the night branch.
    const tree = team.git("ls-tree", "-r", "--name-only", "night/2026-11-11");
    expect(tree).toContain("ai/x/ok.txt");
    expect(tree).not.toContain("web/1/hack.txt");

    // Parked work is kept on a branch for the morning.
    expect(team.git("branch", "--list", "ns/2026-11-11/BAD-a1")).toContain("BAD");

    // Board traffic: claims, done, parked, assumption, lease request — all structured.
    const board = readFileSync(team.board, "utf8");
    for (const type of ["node_up", "task_claimed", "task_done", "task_parked", "assumption", "lease_request", "ask", "answer", "node_down"]) {
      expect(board).toContain(`\\"type\\":\\"${type}\\"`);
    }
    // Every node did some work (lanes keep all four busy).
    for (const d of daemons) expect(d.merges).toBeGreaterThan(0);
    // main is untouched.
    expect(team.git("log", "--format=%s", "main")).toBe("seed");
  }, 60_000);

  it("other nodes take over the tasks of a node that dies mid-task", async () => {
    const team = makeTeam({
      tasks: [
        { id: "SLOW", title: "Slow core task", lane: "core", lease: ["core/**"], fake: { sleep_ms: 30_000, writes: { "core/a.txt": "a" } } },
        { id: "W1", title: "web", lane: "frontend", lease: ["web/**"], fake: { writes: { "web/a.txt": "a" } } },
      ],
      night: { limits: { task_minutes: 1, stuck_minutes: 1, stale_claim_minutes: 0.03, heartbeat_seconds: 0.5, command_timeout_seconds: 20, retries: 1 } },
    });
    // Aditri's node claims SLOW, then "the Mac sleeps": we stop its heartbeat by killing the daemon.
    const aditri = new NightDaemon({ root: team.clones.aditri, node: "aditri", loopMs: 100 });
    const p = aditri.start();
    while (!aditri.running.has("SLOW")) await new Promise((r) => setTimeout(r, 50));
    aditri.stop("simulated crash");
    await p;
    // Make the takeover runner fast this time.
    const others = NODES.filter((n) => n.id !== "aditri").map((n) => new NightDaemon({ root: team.clones[n.id], node: n.id, loopMs: 100 }));
    for (const d of others) {
      const slow = d.tasks.find((t) => t.id === "SLOW")!;
      slow.fake = { writes: { "core/a.txt": "a" } };
    }
    await Promise.all(others.map((d) => d.start()));
    const tree = team.git("ls-tree", "-r", "--name-only", "night/2026-11-11");
    expect(tree).toContain("core/a.txt");
    const board = readFileSync(team.board, "utf8");
    expect(board).toMatch(/taking over from aditri/);
  }, 60_000);

  it("delivers board messages to a running worker mid-task", async () => {
    const team = makeTeam({
      tasks: [
        { id: "LISTEN", title: "Waits for a message", lane: "frontend", lease: ["web/**"], fake: { wait_inbox_ms: 10_000, inbox_file: "web/inbox.txt", writes: { "web/a.txt": "a" } } },
        { id: "TALK", title: "Sends a note", lane: "core", lease: ["core/**"], fake: { sleep_ms: 300, note: { to: "lane:frontend", text: "API field renamed to owner_id" }, writes: { "core/a.txt": "a" } } },
      ],
      nodes: [NODES[0], NODES[3]],
    });
    const ds = [new NightDaemon({ root: team.clones.ethan, node: "ethan", loopMs: 100 }), new NightDaemon({ root: team.clones.aditri, node: "aditri", loopMs: 100 })];
    await Promise.all(ds.map((d) => d.start()));
    const inbox = team.git("show", "night/2026-11-11:web/inbox.txt");
    expect(inbox).toContain("API field renamed to owner_id");
  }, 60_000);

  it("a stuck agent is killed by the watchdog and retried", async () => {
    const team = makeTeam({
      tasks: [{ id: "HANG", title: "Hangs", lane: "core", lease: ["core/**"], fake: { stuck: true } }],
      nodes: [NODES[3]],
      night: { limits: { task_minutes: 1, stuck_minutes: 0.02, stale_claim_minutes: 1, heartbeat_seconds: 0.5, command_timeout_seconds: 20, retries: 1 }, review: { enabled: false, max_rounds: 1 } },
    });
    const d = new NightDaemon({ root: team.clones.aditri, node: "aditri", loopMs: 100 });
    const t0 = Date.now();
    await d.start();
    expect(Date.now() - t0).toBeLessThan(20_000);
    const board = readFileSync(team.board, "utf8");
    expect(board).toContain("Parked HANG");
    expect(board).toMatch(/stuck/);
  }, 30_000);
});
