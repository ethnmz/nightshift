// Builds a throwaway "team": one bare remote (stands in for GitHub) and one clone per
// node (stands in for each teammate's Mac), plus a shared file board.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";

export const NODES = [
  { id: "ethan", name: "Ethan", login: "ethnmz", lanes: ["frontend"] },
  { id: "diego", name: "Diego", login: "Navibytes", lanes: ["voice"] },
  { id: "akshi", name: "Akshi", login: "biswalakshi", lanes: ["ai"] },
  { id: "aditri", name: "Aditri", login: "aditrit06", lanes: ["core"] },
];

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    stdio: ["ignore", "pipe", "pipe"],
  }).toString().trim();

export function makeTeam(opts: { tasks: unknown[]; night?: Record<string, unknown>; nodes?: typeof NODES }) {
  const dir = mkdtempSync(join(tmpdir(), "nightshift-test-"));
  const remote = join(dir, "remote.git");
  const seed = join(dir, "seed");
  git(dir, "init", "-q", "--bare", "-b", "main", remote);
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "# fixture\n");
  writeFileSync(join(seed, ".gitignore"), ".nightshift/local/\n");
  mkdirSync(join(seed, ".nightshift"));
  const nodes = opts.nodes ?? NODES;
  const night = {
    version: 1,
    project: "fixture",
    night: "2026-11-11",
    board: { kind: "file", path: "../board.jsonl" },
    nodes,
    authorize: { board_posts: true, merge_to_night_branch: true, work_stealing: true, contract_changes: true, decide_with_assumptions: true },
    check: "test -f README.md",
    concurrency: 2,
    adapter: "fake",
    poll_seconds: 0.2,
    limits: { task_minutes: 1, stuck_minutes: 0.05, stale_claim_minutes: 0.05, heartbeat_seconds: 0.5, command_timeout_seconds: 20, retries: 1 },
    steal: { idle_seconds: 0 },
    ...opts.night,
  };
  writeFileSync(join(seed, ".nightshift", "night.yaml"), YAML.stringify(night));
  writeFileSync(join(seed, ".nightshift", "tasks.yaml"), YAML.stringify({ tasks: opts.tasks }));
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-q", "origin", "main");
  const clones: Record<string, string> = {};
  for (const n of nodes) {
    const c = join(dir, `mac-${n.id}`);
    git(dir, "clone", "-q", remote, c);
    clones[n.id] = c;
  }
  return {
    dir,
    remote,
    clones,
    board: join(dir, "board.jsonl"),
    git: (...args: string[]) => git(dir, "--git-dir", remote, ...args),
  };
}
