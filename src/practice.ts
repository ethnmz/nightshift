// A practice night: a throwaway team (bare git remote + one clone per teammate + a shared
// file board) with the fake agent, so anyone can watch a whole night in about two minutes.
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";

export function createPractice(dir: string): { dir: string; clones: Record<string, string> } {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_NAME: "seed", GIT_AUTHOR_EMAIL: "s@s", GIT_COMMITTER_NAME: "seed", GIT_COMMITTER_EMAIL: "s@s" };
  const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env, stdio: "pipe", windowsHide: true }).toString();
  const nodes = [
    { id: "ethan", name: "Ethan", lanes: ["frontend"], agent: "claude" },
    { id: "diego", name: "Diego", lanes: ["voice"], agent: "claude" },
    { id: "akshi", name: "Akshi", lanes: ["ai"], agent: "codex" },
    { id: "aditri", name: "Aditri", lanes: ["core"], agent: "claude" },
  ];
  const w = (id: string, path: string, ms: number, extra: Record<string, unknown> = {}) => ({ sleep_ms: ms, writes: { [path]: `// ${id}\n` }, ...extra });
  const tasks = [
    { id: "T1", title: "Backend skeleton + test setup", lane: "core", lease: ["backend/core/**"], acceptance: ["test -f backend/core/app.ts"], fake: w("T1", "backend/core/app.ts", 6000) },
    { id: "T2", title: "Data model and SQLite store", lane: "core", depends_on: ["T1"], lease: ["backend/store/**"], fake: w("T2", "backend/store/db.ts", 9000, { assume: "Use SQLite WAL mode; no migrations tool tonight" }) },
    { id: "T3", title: "Handoff state machine", lane: "core", depends_on: ["T2"], lease: ["backend/state/**"], fake: w("T3", "backend/state/machine.ts", 8000) },
    { id: "F1", title: "App shell and routing", lane: "frontend", depends_on: ["T1"], lease: ["frontend/shell/**"], fake: w("F1", "frontend/shell/App.tsx", 7000) },
    { id: "F2", title: "Create screen on fixtures", lane: "frontend", depends_on: ["F1"], lease: ["frontend/create/**"], fake: w("F2", "frontend/create/Create.tsx", 10000, { review: "changes-once", ask: { to: "lane:core", question: "Is owner_id nullable on follow-ups?" } }) },
    { id: "F3", title: "Receive screen on fixtures", lane: "frontend", depends_on: ["F1"], lease: ["frontend/receive/**"], fake: w("F3", "frontend/receive/Receive.tsx", 9000) },
    { id: "V1", title: "Speech-to-text service", lane: "voice", depends_on: ["T1"], lease: ["backend/stt/**"], fake: w("V1", "backend/stt/stt.ts", 8000, { fail: "first" }) },
    { id: "V2", title: "Statement ingest route", lane: "voice", depends_on: ["V1", "T2"], lease: ["backend/ingest/**"], fake: w("V2", "backend/ingest/route.ts", 7000, { note: { to: "lane:frontend", text: "POST /statements now accepts multipart `file`" } }) },
    { id: "A1", title: "LLM client with schema validation", lane: "ai", depends_on: ["T1"], lease: ["backend/llm/**"], fake: w("A1", "backend/llm/client.ts", 7000) },
    { id: "A2", title: "Extraction prompt + quote check", lane: "ai", depends_on: ["A1"], lease: ["backend/extract/**"], fake: w("A2", "backend/extract/extract.ts", 9000, { assume: "Quotes must be 3-30 words, verbatim" }) },
    { id: "A3", title: "Clarification question phrasing", lane: "ai", depends_on: ["A2"], lease: ["backend/clarify/**"], acceptance: ["false"], fake: w("A3", "backend/clarify/phrase.ts", 5000) },
    { id: "A4", title: "Briefing generator", lane: "ai", depends_on: ["A3"], lease: ["backend/briefing/**"], fake: w("A4", "backend/briefing/brief.ts", 5000) },
    { id: "I1", title: "End-to-end demo test", lane: "core", depends_on: ["T3", "F2", "F3", "V2", "A2"], lease: ["tests/**"], fake: w("I1", "tests/demo.test.ts", 6000) },
  ];
  const night = {
    version: 1, project: "shiftsync-rehearsal", night: "auto",
    board: { kind: "file", path: "../board.jsonl" }, nodes,
    authorize: { board_posts: true, merge_to_night_branch: true, work_stealing: true, contract_changes: true, decide_with_assumptions: true },
    check: "test -f README.md", gate: { command: "test -f README.md", every: 2 },
    concurrency: 2, adapter: "fake", poll_seconds: 2,
    limits: { task_minutes: 5, stuck_minutes: 2, stale_claim_minutes: 1, heartbeat_seconds: 5, command_timeout_seconds: 60, retries: 1 },
    steal: { idle_seconds: 5 },
  };
  const remote = join(dir, "remote.git");
  git(dir, "init", "-q", "--bare", "-b", "main", remote);
  const seed = join(dir, "seed");
  mkdirSync(join(seed, ".nightshift"), { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "# ShiftSync rehearsal\n");
  writeFileSync(join(seed, ".gitignore"), ".nightshift/local/\n");
  writeFileSync(join(seed, ".nightshift/night.yaml"), YAML.stringify(night));
  writeFileSync(join(seed, ".nightshift/tasks.yaml"), YAML.stringify({ tasks }));
  const osOf: Record<string, string> = { ethan: "mac", diego: "windows", akshi: "windows", aditri: "windows" };
  writeFileSync(
    join(seed, ".nightshift/setup.json"),
    JSON.stringify(
      {
        version: 1,
        event: { name: "Practice night", track: "A pretend ShiftSync build", deadline: "", links: "" },
        idea: { pitch: "Watch four teammates' agents build a project overnight, with no AI usage.", problem: "", demo: "", must: "", nice: "", stack: "", rules: "" },
        team: nodes.map((n) => ({ id: n.id, name: n.name, github: "", os: osOf[n.id], agent: n.agent, roles: n.lanes.join(", ") })),
        rules: { perComputer: 2, usageCap: 25, review: true, stealing: true, contractsOwner: "aditri", check: "test -f README.md" },
      },
      null,
      2,
    ),
  );
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-q", "origin", "main");
  for (const n of nodes) git(dir, "clone", "-q", remote, join(dir, `pc-${n.id}`));

  const clones: Record<string, string> = {};
  for (const n of nodes) clones[n.id] = join(dir, `pc-${n.id}`);
  return { dir, clones };
}
