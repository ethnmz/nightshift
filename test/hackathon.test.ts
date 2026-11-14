// "Sleep easy" and "Win the hackathon": live status note, alerts, lost logins, deadline,
// must-haves first, retries, reserved folders, and the submission kit.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { RelayDaemon } from "../src/daemon.js";
import { pickNext, readiness } from "../src/scheduler.js";
import { RelayConfig, Task, loadConfig } from "../src/config.js";
import { draftSubmission, commitSubmission } from "../src/submission.js";
import { makeTeam, NODES } from "./helpers.js";

const RUN = "2026-11-11";
const board = (team: ReturnType<typeof makeTeam>) => (existsSync(team.board) ? readFileSync(team.board, "utf8") : "");
const posts = (team: ReturnType<typeof makeTeam>) =>
  board(team)
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l).text as string);

describe("sleep easy", () => {
  it("keeps one live progress note for the run, written by the first teammate who is up", async () => {
    const team = makeTeam({
      nodes: [NODES[0], NODES[3]],
      tasks: [
        { id: "C1", title: "Core one", lane: "core", lease: ["core/1/**"], fake: { sleep_ms: 800, writes: { "core/1/a.txt": "a" } } },
        { id: "W1", title: "Web one", lane: "frontend", lease: ["web/**"], fake: { sleep_ms: 800, writes: { "web/a.txt": "a" } } },
      ],
      config: { status_every_minutes: 0.01 },
    });
    await Promise.all([new RelayDaemon({ root: team.clones.ethan, node: "ethan", loopMs: 100 }).start(), new RelayDaemon({ root: team.clones.aditri, node: "aditri", loopMs: 100 }).start()]);
    const status = readFileSync(join(dirname(team.board), `status-${RUN}.md`), "utf8");
    expect(status).toContain(`<!-- relay-status run=${RUN} -->`);
    expect(status).toContain("2 / 2 merged");
    expect(status).toContain("**Ethan**");
    expect(status).toContain("**Aditri**");
    // The note is not a board message: no envelope, nothing for agents to act on.
    expect(posts(team).some((t) => t.includes("relay-status"))).toBe(false);
  }, 60_000);

  it("alerts the lead once per kind, and has a teammate relay alerts raised on the lead's own computer", async () => {
    const team = makeTeam({ nodes: [NODES[0], NODES[1]], tasks: [], config: { alerts: { mention: "ethnmz" } } });
    const lead = new RelayDaemon({ root: team.clones.ethan, node: "ethan", loopMs: 100 });
    await lead.alert("gate", "The full check failed twice.");
    await lead.alert("gate", "The full check failed twice."); // de-duplicated
    let p = posts(team);
    expect(p.filter((t) => t.includes("full check failed"))).toHaveLength(1);
    expect(p[0]).not.toContain("@ethnmz"); // GitHub would not notify Ethan of his own post
    // Diego's computer sees it and relays it with the mention.
    const diego = new RelayDaemon({ root: team.clones.diego, node: "diego", loopMs: 100 });
    for (const m of await diego.board.fetchAll()) diego.ingest(m, false);
    await new Promise((r) => setTimeout(r, 200));
    p = posts(team);
    expect(p.some((t) => t.includes("@ethnmz ⚠ The full check failed twice."))).toBe(true);
    // An alert raised on a teammate's computer mentions the lead directly.
    await diego.alert("budget", "Diego hit the usage cap.");
    expect(posts(team).some((t) => t.includes("@ethnmz ⚠ Diego hit the usage cap."))).toBe(true);
  }, 30_000);

  it("a lost login hands the task to a teammate, pauses that computer and alerts the lead", async () => {
    const team = makeTeam({
      nodes: [NODES[0], NODES[3]],
      tasks: [{ id: "C1", title: "Core task", lane: "core", lease: ["core/**"], fake: { auth_fail: true, auth_fail_node: "aditri", writes: { "core/a.txt": "a" } } }],
      config: { alerts: { mention: "ethnmz" } },
    });
    const aditri = new RelayDaemon({ root: team.clones.aditri, node: "aditri", loopMs: 100 });
    const pA = aditri.start();
    while (!aditri.authLost) await new Promise((r) => setTimeout(r, 50));
    await new RelayDaemon({ root: team.clones.ethan, node: "ethan", loopMs: 100 }).start();
    aditri.stop("test done");
    await pA;
    expect(team.git("ls-tree", "-r", "--name-only", `relay/${RUN}`)).toContain("core/a.txt");
    const p = posts(team).join("\n");
    expect(p).toContain("Released C1");
    expect(p).toContain("login stopped working");
    expect(p).toMatch(/@ethnmz ⚠ Aditri's Claude Code login stopped working/);
    expect(p).not.toContain("Parked C1");
  }, 60_000);
});

describe("win the hackathon", () => {
  it("starts nothing new after the deadline cutoff", async () => {
    const team = makeTeam({
      nodes: [NODES[0]],
      tasks: [{ id: "W1", title: "Web", lane: "frontend", lease: ["web/**"], fake: { writes: { "web/a.txt": "a" } } }],
      config: { deadline: "2000-01-01T09:00", stop_before_minutes: 60 },
    });
    const d = new RelayDaemon({ root: team.clones.ethan, node: "ethan", loopMs: 100 });
    await d.start();
    expect(d.merges).toBe(0);
    expect(posts(team).join("\n")).toContain("Close to the submission deadline");
  }, 30_000);

  const cfg = RelayConfig.parse({
    board: { kind: "file", path: "b" },
    nodes: [{ id: "a", name: "A", lanes: ["web"] }],
    authorize: { board_posts: true, merge_to_run_branch: true, work_stealing: true, contract_changes: true, decide_with_assumptions: true },
  });
  const T = (id: string, extra: Partial<Task> = {}) => Task.parse({ id, title: id, lane: "web", lease: [`${id}/**`], ...extra });
  const base = { cfg, me: cfg.nodes[0], isStale: () => false, localRunning: new Set<string>(), idleMs: 0 };
  const st = (status: "done" | "parked") => ({ task: "", sha: "x", state: { status, node: "a", at: 0, attempt: 1 } });

  it("builds must-haves first, and only must-haves when usage or time is short", () => {
    const tasks = [T("NICE", { priority: "nice" }), T("MUST")];
    expect(pickNext({ ...base, tasks, states: new Map() })?.task.id).toBe("MUST");
    expect(pickNext({ ...base, tasks: [T("NICE", { priority: "nice" })], states: new Map() })?.task.id).toBe("NICE");
    expect(pickNext({ ...base, tasks: [T("NICE", { priority: "nice" })], states: new Map(), mustOnly: true })).toBeNull();
    expect(pickNext({ ...base, tasks, states: new Map(), cutoffAt: 1000, now: 2000 })).toBeNull();
  });

  it("reserved folders keep agents out of folders people are editing", () => {
    const tasks = [T("UI", { lease: ["frontend/screens/**"] }), T("API", { lease: ["backend/**"] })];
    expect(pickNext({ ...base, tasks, states: new Map(), reserves: [["frontend/**"]] })?.task.id).toBe("API");
    expect(pickNext({ ...base, tasks: [tasks[0]], states: new Map(), reserves: [["frontend/**"]] })).toBeNull();
  });

  it("a retry stands in for its parked task, so dependents unblock once it merges", () => {
    const tasks = [T("X"), T("Y", { depends_on: ["X"] }), T("X-r2", { retry_of: "X" })];
    expect(readiness(tasks, new Map([["X", st("parked")]]), () => false).get("Y")).toBe("waiting");
    expect(readiness(tasks, new Map([["X", st("parked")], ["X-r2", st("done")]]), () => false).get("Y")).toBe("ready");
    expect(readiness(tasks.slice(0, 2), new Map([["X", st("parked")]]), () => false).get("Y")).toBe("blocked");
  });

  it("results: retry a set-aside task with a hint, start again, then draft and commit the submission", async () => {
    const team = makeTeam({
      nodes: [NODES[0]],
      tasks: [
        { id: "OK", title: "Works", lane: "frontend", lease: ["web/ok/**"], fake: { writes: { "web/ok/a.txt": "a" } } },
        { id: "BAD", title: "Flaky screen", lane: "frontend", lease: ["web/bad/**"], fake: { fail: true, writes: { "web/bad/a.txt": "a" } } },
        { id: "AFTER", title: "Needs BAD", lane: "frontend", depends_on: ["BAD"], lease: ["web/after/**"], fake: { writes: { "web/after/a.txt": "a" } } },
      ],
    });
    const root = team.clones.ethan;
    await new RelayDaemon({ root, node: "ethan", loopMs: 100 }).start();
    expect(team.git("ls-tree", "-r", "--name-only", `relay/${RUN}`)).not.toContain("web/bad/a.txt");

    // Results: the server's retry endpoint, through the real app API.
    const { serve } = await import("../src/server.js");
    const { server } = serve({ root, node: "ethan", port: 0 });
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as { port: number }).port;
    const r = await fetch(`http://localhost:${port}/api/retry`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task: "BAD", hint: "use the mock instead" }) });
    const body = (await r.json()) as { id: string };
    expect(r.status).toBe(200);
    expect(body.id).toBe("BAD-r2");

    // Starting again picks up the retry, and AFTER unblocks behind it.
    const again = new RelayDaemon({ root, node: "ethan", loopMs: 100, runId: RUN });
    expect(again.tasks.length).toBe(3); // the retry is a shared dynamic task, loaded on refresh
    await again.start();
    const retry = again.tasks.find((t) => t.id === "BAD-r2")!;
    expect(retry.brief).toContain("use the mock instead");
    expect(retry.brief).toContain(`relay-work/${RUN}/BAD-a1`);
    const tree = team.git("ls-tree", "-r", "--name-only", `relay/${RUN}`);
    expect(tree).toContain("web/bad/a.txt");
    expect(tree).toContain("web/after/a.txt");
    server.close();

    // Submission kit (fake agent) and the human-approved commit.
    const draft = await draftSubmission(root, "ethan", RUN);
    expect(draft.sections.map((s) => s.title)).toEqual(["How to run", "Demo script", "What works and what's mocked", "Devpost draft"]);
    await commitSubmission(root, "ethan", RUN, draft.markdown);
    expect(team.git("show", `relay/${RUN}:SUBMISSION.md`)).toContain("## Devpost draft");
  }, 90_000);

});
