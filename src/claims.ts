// Task state shared by every node, stored as git refs on the team remote:
//   refs/nightshift/<night>/state/<task>
// Each ref points at a tiny commit (empty tree) whose subject is a JSON TaskState.
// Every transition is a compare-and-swap push (--force-with-lease=<ref>:<expected>),
// so two nodes racing for the same task cannot both win. No server, no leader.
import { Git } from "./git.js";

export type TaskStatus = "claimed" | "done" | "parked";

export interface TaskState {
  status: TaskStatus;
  node: string;
  at: number; // ms since epoch, set by the writer
  attempt: number;
  note?: string;
  merge?: string; // night-branch commit for done tasks
  since?: number; // when this claim started
}

export interface StateRef {
  task: string;
  sha: string;
  state: TaskState;
}

export class Claims {
  constructor(private git: Git, private remote: string, private night: string, private now: () => number = Date.now) {}

  ref(task: string) {
    return `refs/nightshift/${this.night}/state/${task}`;
  }
  private mirror(task = "") {
    return `refs/nightshift-remote/${this.night}/state/${task}`;
  }

  /** Fetch every state ref from the remote and return them by task id. */
  async list(): Promise<Map<string, StateRef>> {
    const spec = `+refs/nightshift/${this.night}/state/*:${this.mirror()}*`;
    const f = await this.git.raw(["fetch", "--quiet", "--prune", "--no-tags", this.remote, spec]);
    if (f.code !== 0) throw new Error(`fetch state refs: ${f.stderr.trim()}`);
    const out = await this.git.ok(["for-each-ref", "--format=%(refname)%00%(objectname)%00%(contents:subject)", this.mirror()]);
    const m = new Map<string, StateRef>();
    for (const line of out.split("\n").filter(Boolean)) {
      const [ref, sha, subject] = line.split("\0");
      const task = ref.slice(this.mirror().length);
      try {
        m.set(task, { task, sha, state: JSON.parse(subject) as TaskState });
      } catch {
        /* a ref we did not write; ignore */
      }
    }
    return m;
  }

  private async write(task: string, expected: string | null, state: TaskState): Promise<string | null> {
    const tree = await this.git.emptyTree();
    const args = ["commit-tree", tree, "-m", JSON.stringify(state)];
    if (expected) args.push("-p", expected);
    const sha = await this.git.ok(args);
    const ref = this.ref(task);
    const r = await this.git.raw([
      "push",
      "--quiet",
      "--porcelain",
      `--force-with-lease=${ref}:${expected ?? ""}`,
      this.remote,
      `${sha}:${ref}`,
    ]);
    return r.code === 0 ? sha : null;
  }

  /** Create the claim. Fails (null) if anyone already has a state for this task. */
  claim(task: string, node: string, attempt = 1): Promise<string | null> {
    const t = this.now();
    return this.write(task, null, { status: "claimed", node, at: t, since: t, attempt });
  }

  /** Move an existing state to a new one, only if it is still `expected`. */
  transition(task: string, expected: string, state: Omit<TaskState, "at"> & { at?: number }): Promise<string | null> {
    return this.write(task, expected, { ...state, at: state.at ?? this.now() } as TaskState);
  }

  /** Dynamic tasks (gate fixers, contract changes) added during the night, shared like states. */
  async addTask(task: object & { id: string }): Promise<boolean> {
    const tree = await this.git.emptyTree();
    const sha = await this.git.ok(["commit-tree", tree, "-m", JSON.stringify(task)]);
    const ref = `refs/nightshift/${this.night}/tasks/${task.id}`;
    const r = await this.git.raw(["push", "--quiet", `--force-with-lease=${ref}:`, this.remote, `${sha}:${ref}`]);
    return r.code === 0;
  }

  async listTasks(): Promise<unknown[]> {
    const mirror = `refs/nightshift-remote/${this.night}/tasks/`;
    const f = await this.git.raw(["fetch", "--quiet", "--prune", "--no-tags", this.remote, `+refs/nightshift/${this.night}/tasks/*:${mirror}*`]);
    if (f.code !== 0) throw new Error(`fetch task refs: ${f.stderr.trim()}`);
    const out = await this.git.ok(["for-each-ref", "--format=%(contents:subject)", mirror]);
    return out
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
  }

  isStale(s: TaskState, staleMs: number): boolean {
    return s.status === "claimed" && this.now() - s.at > staleMs;
  }
}
