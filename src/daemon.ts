// One Nightshift node: the always-on process on one teammate's Mac.
// It watches the board, claims tasks, runs agents in worktrees, enforces leases,
// runs checks and reviews, merges into the night branch, and runs the integration gate.
// Deterministic code owns every decision about state; models only do the task work.
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import picomatch from "picomatch";
import { loadNight, loadTasks, nightBranch, nightName, paths, findNode, Task, NightConfig, NodeSpec, DEFAULT_ALLOW, validateTasks, agentFor, KEY_ENV } from "./config.js";
import { CodexAdapter } from "./agents/codex.js";
import type { UsageInfo } from "./agents/types.js";
import { Git } from "./git.js";
import { Claims, StateRef } from "./claims.js";
import { leaseViolations } from "./lease.js";
import { pickNext, readiness, nightFinished, Pick, Readiness } from "./scheduler.js";
import { Board, FileBoard, GitHubIssueBoard } from "./board/board.js";
import { Envelope, EnvelopeType, addressedTo, humanLine, isStopText, BoardMessage } from "./board/envelope.js";
import { Ledger } from "./ledger.js";
import { Adapter, AgentRequest, AgentResult, NightshiftTools, Role } from "./agents/types.js";
import { ClaudeAdapter } from "./agents/claude.js";
import { FakeAdapter } from "./agents/fake.js";
import { prompt, bullets } from "./prompts.js";
import { sh, tail, run, agentGuardEnv } from "./exec.js";
import { Mutex, sleep } from "./mutex.js";

export interface RunningInfo {
  task: string;
  title: string;
  lane: string;
  role: Role;
  phase: string;
  startedAt: number;
  lastActivity: number;
  lastText: string;
  cost: number;
  attempt: number;
  stolen: boolean;
}

interface Running extends RunningInfo {
  abort: AbortController;
  inbox: string[];
  lost: boolean;
  claimSha: string;
  stateLock: Mutex;
}

export interface DaemonOpts {
  root: string;
  node: string;
  adapter?: Adapter;
  board?: Board;
  loopMs?: number;
  /** Exit when the night is finished (default true). The dashboard server keeps running separately. */
  exitWhenDone?: boolean;
}

export class NightDaemon {
  cfg: NightConfig;
  me: NodeSpec;
  night: string;
  branch: string;
  root: string;
  local: string;
  git: Git;
  claims: Claims;
  board: Board;
  ledger: Ledger;
  adapter: Adapter;
  baseTasks: Task[];
  dynamicTasks = new Map<string, Task>();
  states = new Map<string, StateRef>();
  running = new Map<string, Running>();
  remoteLock = new Mutex();
  stopped = false;
  stopReason = "";
  finished = false;
  spentByNode = new Map<string, number>();
  assumptions = 0;
  merges = 0;
  agent: "claude" | "codex" | "fake" = "claude";
  /** Latest subscription usage reported by this node's agent, and by other nodes (from the board). */
  usage: UsageInfo | undefined;
  usageByNode = new Map<string, UsageInfo>();
  /** Set when the subscription's usage limit is hit: no new tasks until then. */
  pausedUntil = 0;
  private seenMsgs = new Set<string>();
  private laneBacklog = new Map<string, string[]>();
  private idleSince = Date.now();
  private loopMs: number;
  private answering = false;
  private answerQueue: Envelope[] = [];
  private counter = 0;
  private exitWhenDone: boolean;

  constructor(o: DaemonOpts) {
    this.root = o.root;
    this.cfg = loadNight(o.root);
    this.me = findNode(this.cfg, o.node);
    this.night = nightName(this.cfg);
    this.branch = nightBranch(this.night);
    const p = paths(o.root);
    this.local = join(p.local, this.me.id);
    mkdirSync(this.local, { recursive: true });
    this.git = new Git(o.root, { name: `${this.me.name} (nightshift)`, email: `${this.me.id}@nightshift.local` });
    this.claims = new Claims(this.git, this.cfg.remote, this.night);
    this.ledger = new Ledger(join(this.local, `ledger-${this.night}.jsonl`), this.me.id);
    this.board = o.board ?? makeBoard(this.cfg, o.root, join(this.local, "board-cursor"));
    this.agent = agentFor(this.cfg, this.me);
    this.adapter = o.adapter ?? (this.agent === "fake" ? new FakeAdapter(this.me.id) : this.agent === "codex" ? new CodexAdapter() : new ClaudeAdapter());
    this.baseTasks = loadTasks(o.root);
    this.loopMs = o.loopMs ?? 3000;
    this.exitWhenDone = o.exitWhenDone ?? true;
  }

  // ---------- shared helpers ----------

  get tasks(): Task[] {
    return [...this.baseTasks, ...this.dynamicTasks.values()];
  }
  get spentNode(): number {
    return this.spentByNode.get(this.me.id) ?? 0;
  }
  get spentTeam(): number {
    return [...this.spentByNode.values()].reduce((a, b) => a + b, 0);
  }
  private staleMs() {
    return this.cfg.limits.stale_claim_minutes * 60_000;
  }
  private addSpend(usd: number) {
    this.spentByNode.set(this.me.id, this.spentNode + usd);
  }
  private remoteNight() {
    return `refs/remotes/${this.cfg.remote}/${this.branch}`;
  }

  async post(type: EnvelopeType, text: string, fields: Partial<Envelope> = {}) {
    const env: Envelope = {
      v: 1,
      from: this.me.id,
      to: fields.to ?? "*",
      type,
      task: fields.task,
      body: { ...(fields.body ?? {}), spent: Number(this.spentNode.toFixed(4)), ...(this.usage ? { usage: this.usage } : {}), ...(this.paused() ? { paused_until: this.pausedUntil } : {}) },
      at: Date.now(),
      night: this.night,
    };
    this.ledger.add("posted", { task: env.task, data: { type, to: env.to, text } });
    try {
      await this.board.post(humanLine(this.me.name, text), env);
    } catch (e) {
      this.ledger.add("error", { data: { where: "board.post", error: String(e) } });
    }
  }

  private async fetchNight(): Promise<string> {
    return this.remoteLock.run(async () => {
      await this.git.ok(["fetch", "--quiet", "--no-tags", this.cfg.remote, `+refs/heads/${this.branch}:${this.remoteNight()}`]);
      return (await this.git.revParse(this.remoteNight()))!;
    });
  }

  async refreshStates() {
    await this.remoteLock.run(async () => {
      this.states = await this.claims.list();
      for (const raw of await this.claims.listTasks()) {
        const r = Task.safeParse(raw);
        if (r.success && !this.dynamicTasks.has(r.data.id) && !this.baseTasks.some((t) => t.id === r.data.id)) {
          this.dynamicTasks.set(r.data.id, r.data);
        }
      }
      validateTasks(this.tasks);
      await this.git.raw(["fetch", "--quiet", "--no-tags", this.cfg.remote, `+refs/heads/${this.branch}:${this.remoteNight()}`]);
      const log = await this.git.raw(["log", "--format=%(trailers:key=Nightshift-Task,valueonly)", this.remoteNight()]);
      if (log.code === 0) this.mergedOnNight = new Set(log.stdout.split("\n").map((x) => x.trim()).filter(Boolean));
    });
  }

  statesWithMerged(): Map<string, StateRef> {
    const states = new Map(this.states);
    for (const id of this.mergedOnNight) {
      const s = states.get(id);
      if (s?.state.status !== "done") states.set(id, { task: id, sha: s?.sha ?? "", state: { status: "done", node: s?.state.node ?? "?", at: Date.now(), attempt: s?.state.attempt ?? 1 } });
    }
    return states;
  }

  /** Task ids whose squash commit is on the night branch (the ground truth, even if a state write was lost). */
  mergedOnNight = new Set<string>();

  readinessNow(): Map<string, Readiness> {
    return readiness(this.tasks, this.statesWithMerged(), (s) => this.claims.isStale(s.state, this.staleMs()));
  }

  // ---------- lifecycle ----------

  /** Creates the night branch from the base branch if no node has yet (compare-and-swap create). */
  async ensureNightBranch() {
    await this.remoteLock.run(async () => {
      const base = this.cfg.base_branch;
      await this.git.ok(["fetch", "--quiet", "--no-tags", this.cfg.remote, `+refs/heads/${base}:refs/remotes/${this.cfg.remote}/${base}`]);
      const sha = await this.git.revParse(`refs/remotes/${this.cfg.remote}/${base}`);
      if (!sha) throw new Error(`base branch ${base} not found on ${this.cfg.remote}`);
      const ref = `refs/heads/${this.branch}`;
      await this.git.raw(["push", "--quiet", `--force-with-lease=${ref}:`, this.cfg.remote, `${sha}:${ref}`]); // fails harmlessly if it exists
    });
    await this.fetchNight();
  }

  stopFile() {
    return join(this.local, "STOP");
  }

  stop(reason: string) {
    if (this.stopped) return;
    this.stopped = true;
    this.stopReason = reason;
    this.ledger.add("stopped", { data: { reason } });
    for (const r of this.running.values()) r.abort.abort();
  }

  async start(): Promise<void> {
    if (existsSync(this.stopFile())) rmSync(this.stopFile());
    this.ledger.add("node_start", { data: { night: this.night, adapter: this.adapter.name, board: this.board.describe() } });
    await this.ensureNightBranch();
    await this.replayBoard();
    await this.post("node_up", `${this.me.name}'s node is up for night ${this.night} (lanes: ${this.me.lanes.join(", ")}).`, {
      body: { lanes: this.me.lanes, concurrency: this.cfg.concurrency },
    });
    const boardLoop = this.boardLoop();
    try {
      await this.schedLoop();
    } finally {
      this.stop(this.stopReason || "night finished");
      await boardLoop.catch(() => {});
      const s = this.summary();
      await this.post("node_down", `${this.me.name}'s node is done: ${s}`, { body: { merges: this.merges, reason: this.stopReason } });
    }
  }

  summary(): string {
    const r = this.readinessNow();
    const count = (k: Readiness) => [...r.values()].filter((x) => x === k).length;
    return `${count("done")} done, ${count("parked")} parked, ${count("blocked")} blocked, ${this.merges} merged by this node, $${this.spentNode.toFixed(2)} spent`;
  }

  private async schedLoop() {
    while (!this.stopped) {
      if (existsSync(this.stopFile())) {
        this.stop("local stop file");
        break;
      }
      try {
        await this.refreshStates();
      } catch (e) {
        this.ledger.add("error", { data: { where: "refresh", error: String(e) } }); // network blip: retry next tick
        await sleep(this.loopMs * 2);
        continue;
      }
      const r = this.readinessNow();
      if (nightFinished(r) && this.running.size === 0) {
        this.finished = true;
        this.stopReason = "night finished";
        if (this.exitWhenDone) break;
      }
      const overBudget = this.spentNode >= this.cfg.budget.node_usd || this.spentTeam >= this.cfg.budget.team_usd;
      if (overBudget && !this.stopReason) {
        this.stopReason = "budget reached";
        await this.post("budget", `Budget reached (node $${this.spentNode.toFixed(2)}, team $${this.spentTeam.toFixed(2)}). No new tasks from this node.`);
      }
      while (!overBudget && !this.paused() && !this.finished && this.running.size < this.cfg.concurrency) {
        const pick = pickNext({
          tasks: this.tasks,
          states: this.statesWithMerged(),
          isStale: (s) => this.claims.isStale(s.state, this.staleMs()),
          me: this.me,
          cfg: this.cfg,
          localRunning: new Set(this.running.keys()),
          idleMs: this.running.size === 0 ? Date.now() - this.idleSince : 0,
        });
        if (!pick) break;
        const claimed = await this.claim(pick);
        if (!claimed) break; // lost a race; re-read state next tick
      }
      if (overBudget && this.running.size === 0) break;
      if (this.running.size > 0) this.idleSince = Date.now();
      await sleep(this.loopMs);
    }
    // Let running tasks wind down (they were aborted if stopped).
    while (this.running.size > 0) await sleep(200);
  }

  // ---------- board ----------

  private async replayBoard() {
    try {
      const all = await this.board.fetchAll();
      for (const m of all) this.ingest(m, true);
    } catch (e) {
      this.ledger.add("error", { data: { where: "board.replay", error: String(e) } });
    }
  }

  private async boardLoop() {
    while (!this.stopped) {
      try {
        for (const m of await this.board.fetchNew()) this.ingest(m, false);
      } catch (e) {
        this.ledger.add("error", { data: { where: "board.fetch", error: String(e) } });
      }
      const until = Date.now() + this.cfg.poll_seconds * 1000;
      while (!this.stopped && Date.now() < until) await sleep(Math.min(250, this.cfg.poll_seconds * 1000));
    }
  }

  /** Route one board message. `replay` = startup catch-up: update totals, do not act. */
  ingest(m: BoardMessage, replay: boolean) {
    if (this.seenMsgs.has(m.id)) return;
    this.seenMsgs.add(m.id);
    const env = m.env;
    if (!env) {
      if (!replay && isStopText(m.text)) this.stop(`stop posted on the board by ${m.author}`);
      return;
    }
    if (env.night && env.night !== this.night) return;
    if (env.body.usage && typeof env.body.usage === "object") this.usageByNode.set(env.from, env.body.usage as UsageInfo);
    if (typeof env.body.spent === "number") this.spentByNode.set(env.from, Math.max(this.spentByNode.get(env.from) ?? 0, env.body.spent as number));
    if (replay) return;
    this.ledger.add("board", { task: env.task, data: { from: env.from, to: env.to, type: env.type, body: env.body } });

    if (env.type === "stop") return this.stop(`stop from ${env.from}`);
    const fromTask = env.body.from_task as string | undefined;
    const line = `[${env.from}${fromTask ? "/" + fromTask : ""} → ${env.to}] (${env.type}${env.body.question_id ? " " + env.body.question_id : ""}) ${String(env.body.text ?? env.body.question ?? env.body.change ?? "").slice(0, 1500)}`;
    const deliverable: EnvelopeType[] = ["note", "ask", "answer", "contract_change", "lease_request", "blocker", "gate_failed"];
    if (!deliverable.includes(env.type)) return;

    let delivered = false;
    for (const r of this.running.values()) {
      if (r.task === fromTask) continue;
      if (addressedTo(env, { node: this.me.id, lane: r.lane, task: r.task })) {
        r.inbox.push(line);
        delivered = true;
      }
    }
    // Lane messages with no live worker wait for the next task in that lane.
    if (!delivered && env.to.startsWith("lane:") && this.me.lanes.includes(env.to.slice(5)) && env.type !== "ask") {
      const lane = env.to.slice(5);
      this.laneBacklog.set(lane, [...(this.laneBacklog.get(lane) ?? []), line].slice(-20));
    }
    if (env.type === "ask") this.maybeAnswer(env, delivered);
    if (env.type === "contract_change") void this.maybeQueueContractChange(env);
  }

  /** The first node (in night.yaml order) that owns a lane answers for it, so there is exactly one responder. */
  private responderFor(lane: string): string | undefined {
    return this.cfg.nodes.find((n) => n.lanes.includes(lane))?.id;
  }

  private maybeAnswer(env: Envelope, deliveredToLiveWorker: boolean) {
    const lane = env.to.startsWith("lane:") ? env.to.slice(5) : undefined;
    const mine = (lane && this.responderFor(lane) === this.me.id) || env.to === `node:${this.me.id}`;
    // Always answer with a dedicated read-only answerer: a busy builder that merely saw the
    // question in its context may never reply. (Live workers still see it, as information.)
    void deliveredToLiveWorker;
    if (!mine) return;
    this.answerQueue.push(env);
    void this.drainAnswers();
  }

  private async drainAnswers() {
    if (this.answering) return;
    this.answering = true;
    try {
      while (this.answerQueue.length && !this.stopped) {
        const q = this.answerQueue.shift()!;
        await this.answer(q).catch((e) => this.ledger.add("error", { data: { where: "answer", error: String(e) } }));
      }
    } finally {
      this.answering = false;
    }
  }

  private async answer(q: Envelope) {
    const lane = q.to.startsWith("lane:") ? q.to.slice(5) : this.me.lanes[0];
    const wt = join(this.local, "wt", "_answer");
    const head = await this.fetchNight();
    await this.freshWorktree(wt, head, null);
    const res = await this.runAgent({
      role: "answerer",
      cwd: wt,
      readOnly: true,
      prompt: prompt("answerer", { lane, question: String(q.body.question ?? ""), asker: `${q.from}/${q.body.from_task ?? "?"}`, contracts: this.cfg.contracts.join(", ") || "(none)" }),
      maxTurns: 12,
      minutes: 8,
      taskForLog: `answer-${q.body.question_id ?? ""}`,
    });
    const to = q.body.from_task ? `task:${q.body.from_task}` : `node:${q.from}`;
    await this.post("answer", `Answer for ${to} (lane ${lane}): ${res.text.slice(0, 200)}`, {
      to,
      body: { text: res.text.slice(0, 4000), question_id: q.body.question_id, lane },
    });
  }

  private async maybeQueueContractChange(env: Envelope) {
    const lane = this.cfg.contract_lane ?? this.laneOwning(String(env.body.file ?? ""));
    if (!lane || this.responderFor(lane) !== this.me.id) return;
    const id = `CC-${this.me.id}-${Date.now().toString(36)}`;
    const t: Task = {
      id,
      title: `Contract change: ${String(env.body.file)}`,
      lane,
      role: "contract",
      brief: prompt("contract", {
        file: String(env.body.file),
        asker: `${env.from}/${env.body.from_task ?? "?"}`,
        reason: String(env.body.reason ?? ""),
        change: String(env.body.change ?? ""),
      }),
      lease: [String(env.body.file), ...(this.cfg.contracts.includes(String(env.body.file)) ? [] : [])],
      depends_on: [],
      contracts: this.cfg.contracts,
      acceptance: [],
    };
    await this.addDynamicTask(t, `Queued contract change ${id} for ${env.body.file}`);
  }

  private laneOwning(file: string): string | undefined {
    for (const t of this.baseTasks) if (picomatch(t.lease, { dot: true })(file)) return t.lane;
    return undefined;
  }

  async addDynamicTask(t: Task, note: string) {
    const ok = await this.remoteLock.run(() => this.claims.addTask(t));
    if (!ok) return;
    this.dynamicTasks.set(t.id, t);
    await this.post("task_added", note, { task: t.id, to: `lane:${t.lane}`, body: { title: t.title, lane: t.lane, role: t.role } });
  }

  // ---------- tools exposed to workers ----------

  private toolsFor(taskId: string, lane: string, reviewSink?: (v: "approve" | "changes", notes: string) => void): NightshiftTools {
    const qid = () => `Q-${this.me.id}-${++this.counter}`;
    return {
      post_note: async ({ to, text }) => {
        await this.post("note", `${taskId}: ${text.slice(0, 300)}`, { to: to ?? "*", task: taskId, body: { text, from_task: taskId, lane } });
        return "posted";
      },
      ask: async ({ to, question }) => {
        const id = qid();
        await this.post("ask", `${taskId} asks ${to}: ${question.slice(0, 300)}`, { to, task: taskId, body: { question, question_id: id, from_task: taskId, lane } });
        return `Question ${id} posted to ${to}. Do not wait: record an assumption and continue. If an answer arrives it will be injected into your context.`;
      },
      answer: async ({ to, text, question_id }) => {
        await this.post("answer", `${taskId} answers ${to}: ${text.slice(0, 300)}`, { to, task: taskId, body: { text, question_id, from_task: taskId, lane } });
        return "answer posted";
      },
      check_board: async () => {
        const r = this.running.get(taskId);
        const msgs = r ? r.inbox.splice(0) : [];
        return msgs.length ? msgs.join("\n") : "No new messages for you.";
      },
      record_assumption: async ({ decision, why }) => {
        this.assumptions++;
        await this.post("assumption", `${taskId} assumed: ${decision.slice(0, 300)}`, { task: taskId, body: { decision, why, from_task: taskId, lane } });
        return "recorded for morning review; continue";
      },
      report_blocker: async ({ kind, detail }) => {
        await this.post("blocker", `${taskId} blocked (${kind}): ${detail.slice(0, 300)}`, { task: taskId, body: { kind, text: detail, from_task: taskId, lane } });
        return "blocker reported; continue with what you can do";
      },
      request_contract_change: async ({ file, change, reason }) => {
        if (!this.cfg.authorize.contract_changes) return "Contract changes are not authorized tonight. Work against the current contract and record an assumption.";
        const lane2 = this.cfg.contract_lane ?? this.laneOwning(file) ?? "*";
        await this.post("contract_change", `${taskId} requests a change to ${file}: ${reason.slice(0, 200)}`, {
          to: lane2 === "*" ? "*" : `lane:${lane2}`,
          task: taskId,
          body: { file, change, reason, from_task: taskId, lane },
        });
        return "Requested. Keep working against the current contract; the steward will apply it and notify everyone.";
      },
      submit_review: async ({ verdict, notes }) => {
        reviewSink?.(verdict, notes);
        return "review recorded";
      },
    };
  }

  // ---------- agent runner with watchdog ----------

  private async runAgent(o: {
    role: Role;
    task?: Task;
    cwd: string;
    readOnly: boolean;
    prompt: string;
    maxTurns?: number;
    minutes?: number;
    resume?: string;
    running?: Running;
    taskForLog?: string;
    reviewSink?: (v: "approve" | "changes", notes: string) => void;
  }): Promise<AgentResult> {
    const abort = new AbortController();
    const outer = o.running?.abort.signal;
    const onOuter = () => abort.abort();
    outer?.addEventListener("abort", onOuter);
    let last = Date.now();
    let reason: AgentResult["reason"];
    const minutes = o.minutes ?? o.task?.minutes ?? this.cfg.limits.task_minutes;
    const stuckMs = this.cfg.limits.stuck_minutes * 60_000;
    const wall = setTimeout(() => {
      reason = "timeout";
      abort.abort();
    }, minutes * 60_000);
    const watch = setInterval(() => {
      if (Date.now() - last > stuckMs) {
        reason = "stuck";
        abort.abort();
      }
    }, Math.min(5000, stuckMs / 2));
    const logTask = o.task?.id ?? o.taskForLog;
    const remainingNode = Math.max(0.01, this.cfg.budget.node_usd - this.spentNode);
    // Codex nodes use the teammate's own model choice (cfg.models are Claude model ids).
    const roleModel = o.role === "reviewer" ? this.cfg.models.reviewer : o.role === "planner" ? this.cfg.models.planner : this.cfg.models.builder;
    const model = this.me.model ?? (this.agent === "claude" ? roleModel : undefined);
    const rules = prompt("rules", {
      project: this.cfg.project,
      node_count: this.cfg.nodes.length,
      lease: (o.task?.lease ?? ["(read-only)"]).join(", "),
      contracts: (o.task?.contracts.length ? o.task.contracts : this.cfg.contracts).join(", ") || "(none listed)",
    });
    const req: AgentRequest = {
      role: o.role,
      task: o.task,
      cwd: o.cwd,
      system: rules + "\n\n" + projectGuide(o.cwd),
      prompt: o.prompt,
      model,
      maxTurns: o.maxTurns ?? o.task?.max_turns ?? this.cfg.limits.max_turns,
      timeoutMs: minutes * 60_000,
      stuckMs,
      maxBudgetUsd: remainingNode,
      allowCommands: this.cfg.allow_commands.length ? this.cfg.allow_commands : DEFAULT_ALLOW,
      readOnly: o.readOnly,
      tools: this.toolsFor(logTask ?? "-", o.task?.lane ?? this.me.lanes[0], o.reviewSink),
      inbox: () => (o.running ? o.running.inbox.splice(0) : []),
      onEvent: (e) => {
        last = Date.now();
        if (o.running) {
          o.running.lastActivity = last;
          if (e.text && (e.kind === "text" || e.kind === "result")) o.running.lastText = e.text.slice(0, 300);
        }
        if (e.kind === "usage" && e.usage) {
          this.usage = e.usage;
          this.usageByNode.set(this.me.id, e.usage);
        }
        if (e.kind === "text" && !e.text) return; // bare activity ping
        this.ledger.add(`agent_${e.kind}`, { task: logTask, role: o.role, data: { tool: e.tool, text: e.text?.slice(0, 1500), input: e.kind === "tool" ? summarizeInput(e.input) : undefined } });
      },
      resume: o.resume,
      env: agentGuardEnv(this.emptyGhDir(), this.cfg.remote),
      removeEnv: this.cfg.auth === "subscription" ? KEY_ENV : [],
      signal: abort.signal,
      fake: o.task?.fake,
    };
    let res: AgentResult;
    try {
      res = await this.adapter.run(req);
    } catch (e) {
      res = { ok: false, reason: "error", text: String(e), costUsd: 0, denials: 0 };
    } finally {
      clearTimeout(wall);
      clearInterval(watch);
      outer?.removeEventListener("abort", onOuter);
    }
    if (reason && !res.ok) res.reason = reason; // our watchdog's reason wins
    if (!reason && abort.signal.aborted && !res.ok) res.reason = "aborted";
    this.addSpend(res.costUsd);
    if (o.running) o.running.cost += res.costUsd;
    if (res.reason === "usage_limit" || (!res.ok && this.paused())) {
      this.pauseForUsage(res.resumeAt);
      throw new UsageLimitHit();
    }
    this.ledger.add("agent_done", { task: logTask, role: o.role, data: { ok: res.ok, reason: res.reason, cost: res.costUsd, denials: res.denials } });
    return res;
  }

  // ---------- the task pipeline ----------

  private async claim(pick: Pick): Promise<boolean> {
    const t = pick.task;
    const prev = pick.takeover;
    const sha = await this.remoteLock.run(() =>
      prev
        ? this.claims.transition(t.id, prev.sha, { status: "claimed", node: this.me.id, attempt: prev.state.attempt + 1, since: Date.now(), note: `taken over from ${prev.state.node}` })
        : this.claims.claim(t.id, this.me.id),
    );
    if (!sha) {
      this.ledger.add("claim_lost", { task: t.id });
      return false;
    }
    const running: Running = {
      task: t.id,
      title: t.title,
      lane: t.lane,
      role: t.role as Role,
      phase: "starting",
      startedAt: Date.now(),
      lastActivity: Date.now(),
      lastText: "",
      cost: 0,
      attempt: prev ? prev.state.attempt + 1 : 1,
      stolen: pick.stolen,
      abort: new AbortController(),
      inbox: [...(this.laneBacklog.get(t.lane) ?? [])],
      lost: false,
      claimSha: sha,
      stateLock: new Mutex(),
    };
    this.laneBacklog.delete(t.lane);
    this.running.set(t.id, running);
    this.ledger.add("task_claimed", { task: t.id, data: { stolen: pick.stolen, takeover: prev?.state.node } });
    void this.post(
      "task_claimed",
      `Claimed ${t.id} (${t.title})${pick.stolen ? ` from lane ${t.lane}` : ""}${prev ? `, taking over from ${prev.state.node}` : ""}.`,
      { task: t.id, body: { lane: t.lane, stolen: pick.stolen, takeover: prev?.state.node ?? null } },
    );
    void this.execute(t, running).finally(() => {
      this.running.delete(t.id);
      this.idleSince = Date.now();
    });
    return true;
  }

  /**
   * Compare-and-swap our task state. Serialized per task (heartbeat vs. done/parked), and if the
   * remote moved but still shows our own claim, re-read and retry. Returns false if we lost the task.
   */
  private transitionMine(t: Task, r: Running, state: Parameters<Claims["transition"]>[2]): Promise<boolean> {
    return r.stateLock.run(async () => {
      for (let i = 0; i < 4; i++) {
        const next = await this.remoteLock.run(() => this.claims.transition(t.id, r.claimSha, state)).catch(() => null);
        if (next) {
          r.claimSha = next;
          return true;
        }
        const cur = (await this.remoteLock.run(() => this.claims.list()).catch(() => null))?.get(t.id);
        if (!cur) continue;
        if (cur.state.node !== this.me.id || cur.state.status !== "claimed") return false;
        r.claimSha = cur.sha;
      }
      return false;
    });
  }

  private heartbeat(t: Task, r: Running): NodeJS.Timeout {
    return setInterval(async () => {
      if (r.lost || r.phase === "done" || r.phase === "parked" || r.phase === "released") return;
      const ok = await this.transitionMine(t, r, { status: "claimed", node: this.me.id, attempt: r.attempt, since: r.startedAt });
      if (!ok && !r.lost && r.phase !== "done" && r.phase !== "parked" && r.phase !== "released") {
        // Someone else owns it now (we looked stale to them). Stop and discard our work.
        r.lost = true;
        r.abort.abort();
        this.ledger.add("claim_lost", { task: t.id });
      }
    }, this.cfg.limits.heartbeat_seconds * 1000);
  }

  private async freshWorktree(wt: string, base: string, branch: string | null) {
    await this.remoteLock.run(async () => {
      if (existsSync(wt)) {
        await this.git.raw(["worktree", "remove", "--force", wt]);
        rmSync(wt, { recursive: true, force: true });
      }
      await this.git.raw(["worktree", "prune"]);
      const args = branch ? ["worktree", "add", "--quiet", "-B", branch, wt, base] : ["worktree", "add", "--quiet", "--detach", wt, base];
      await this.git.ok(args);
    });
  }

  private async removeWorktree(wt: string) {
    await this.remoteLock.run(async () => {
      await this.git.raw(["worktree", "remove", "--force", wt]);
      rmSync(wt, { recursive: true, force: true });
    });
  }

  private async runChecks(t: Task, cwd: string): Promise<{ ok: boolean; output: string }> {
    const cmds = [...t.acceptance, ...(this.cfg.check ? [this.cfg.check] : [])];
    let out = "";
    for (const c of cmds) {
      const r = await sh(c, { cwd, timeoutMs: this.cfg.limits.command_timeout_seconds * 1000 });
      out += `$ ${c}\n${tail(r.stdout, 3000)}${tail(r.stderr, 3000)}\n`;
      this.ledger.add("check", { task: t.id, data: { command: c, code: r.code, timedOut: r.timedOut } });
      if (r.code !== 0) return { ok: false, output: `${out}\n(exit ${r.code}${r.timedOut ? ", timed out — commands must not wait for input or run forever" : ""})` };
    }
    return { ok: true, output: out };
  }

  /** Revert out-of-lease edits deterministically and tell the owning lane what was wanted. */
  private async enforceLease(t: Task, g: Git, base: string): Promise<string[]> {
    const files = await g.changedFiles(base);
    const bad = leaseViolations(files, t.lease);
    if (!bad.length) return [];
    const patch = (await g.raw(["diff", `${base}...HEAD`, "--", ...bad])).stdout;
    for (const f of bad) {
      const inBase = (await g.raw(["cat-file", "-e", `${base}:${f}`])).code === 0;
      if (inBase) await g.ok(["checkout", base, "--", f]);
      else await g.raw(["rm", "-q", "-f", "--", f]);
    }
    await g.commitAll(`${t.id}: revert edits outside lease`);
    const owners = new Set(bad.map((f) => this.laneOwning(f) ?? this.cfg.contract_lane ?? "*"));
    for (const lane of owners) {
      await this.post("lease_request", `${t.id} needed changes outside its lease (${bad.join(", ").slice(0, 200)}). Reverted; owning lane please consider.`, {
        to: lane === "*" ? "*" : `lane:${lane}`,
        task: t.id,
        body: { files: bad, text: `Task ${t.id} wanted these changes outside its lease:\n${tail(patch, 3000)}`, from_task: t.id },
      });
    }
    this.ledger.add("lease_violation", { task: t.id, data: { files: bad } });
    return bad;
  }

  private mergedSummary(): string {
    const done = this.tasks.filter((t) => this.states.get(t.id)?.state.status === "done");
    return done.length ? done.map((t) => `- ${t.id} (${t.lane}): ${t.title}`).join("\n") : "(nothing yet)";
  }

  private async execute(t: Task, r: Running) {
    const hb = this.heartbeat(t, r);
    const wt = join(this.local, "wt", t.id);
    const branch = `ns/${this.night}/${t.id}`;
    let session: string | undefined;
    let failure = "";
    let reviewRounds = 0;
    let base = "";
    try {
      r.phase = "worktree";
      base = await this.fetchNight();
      await this.freshWorktree(wt, base, branch);
      const g = new Git(wt, { name: `${this.me.name} (nightshift)`, email: `${this.me.id}@nightshift.local` });
      const maxAgentRuns = 1 + this.cfg.limits.retries + this.cfg.review.max_rounds;
      let success = false;

      for (let run = 1; run <= maxAgentRuns && !r.lost && !this.stopped; run++) {
        r.phase = run === 1 ? "building" : "fixing";
        r.role = run === 1 ? (t.role as Role) : "fixer";
        const p =
          run === 1
            ? prompt("builder", {
                task_id: t.id,
                title: t.title,
                lane: t.lane,
                role: t.role,
                night_branch: this.branch,
                brief: t.brief || t.title,
                lease_list: bullets(t.lease),
                acceptance_list: bullets(t.acceptance, "(none; the global check still runs)"),
                check: this.cfg.check || "(none)",
                merged: this.mergedSummary(),
                extra: r.inbox.length ? `## Messages waiting for your lane\n${r.inbox.splice(0).join("\n")}` : "",
              })
            : prompt("fixer", { task_id: t.id, title: t.title, lease: t.lease.join(", "), failure: tail(failure, 6000) });
        const res = await this.runAgent({ role: r.role, task: t, cwd: wt, readOnly: false, prompt: p, resume: run > 1 ? session : undefined, running: r });
        session = res.sessionId ?? session;
        if (!res.ok) {
          failure = `The agent run ended without finishing (${res.reason}). ${res.text}`;
          continue;
        }
        await g.commitAll(`${t.id}: ${t.title} (work in progress)`);
        r.phase = "lease";
        await this.enforceLease(t, g, base);
        const files = await g.changedFiles(base);
        if (!files.length && t.role !== "contract") {
          failure = "You finished without changing any file inside your lease. Implement the task.";
          continue;
        }
        r.phase = "checks";
        const checks = await this.runChecks(t, wt);
        if (!checks.ok) {
          failure = `Acceptance/global checks failed:\n${checks.output}`;
          continue;
        }
        if (this.cfg.review.enabled && files.length) {
          r.phase = "review";
          let verdict: "approve" | "changes" | undefined;
          let notes = "";
          const diff = (await g.raw(["diff", `${base}...HEAD`])).stdout;
          const rv = await this.runAgent({
            role: "reviewer",
            task: t,
            cwd: wt,
            readOnly: true,
            maxTurns: 25,
            minutes: Math.min(15, this.cfg.limits.task_minutes),
            prompt: prompt("reviewer", { task_id: t.id, title: t.title, brief: t.brief || t.title, lease_list: bullets(t.lease), diff: tail(diff, 40_000), contracts: t.contracts.join(", ") || "(none)" }),
            running: r,
            reviewSink: (v, n) => {
              verdict = v;
              notes = n;
            },
          });
          if (!verdict) {
            const m = /VERDICT:\s*(approve|changes)\b([\s\S]*)/i.exec(rv.text);
            if (m) {
              verdict = m[1].toLowerCase() as "approve" | "changes";
              notes = (m[2].trim() || rv.text).slice(0, 4000);
            }
          }
          // A reviewer that never submits a verdict does not block the night.
          this.ledger.add("review", { task: t.id, data: { verdict: verdict ?? "none", notes } });
          if (verdict === "changes") {
            reviewRounds++;
            if (reviewRounds >= this.cfg.review.max_rounds) {
              failure = `Reviewer still requested changes after ${reviewRounds} rounds: ${notes}`;
              break;
            }
            failure = `The reviewer requested changes:\n${notes}`;
            continue;
          }
        }
        success = true;
        break;
      }

      if (r.lost) return;
      if (!success || this.stopped) {
        if (this.stopped) return; // claim goes stale; a restarted night can take it over
        await this.park(t, r, g, failure || "ran out of attempts");
        return;
      }

      r.phase = "merging";
      const merged = await this.merge(t, r, g, base);
      if (!merged) return;
      await this.finishDone(t, r, merged, await g.changedFiles(`${merged}~1`, merged).catch(() => []));
      await this.maybeGate();
    } catch (e) {
      if (e instanceof UsageLimitHit) {
        if (!r.lost && !this.stopped) await this.release(t, r, "usage limit reached on this teammate's plan").catch(() => {});
        return;
      }
      this.ledger.add("error", { task: t.id, data: { where: "execute", error: String(e) } });
      if (!r.lost && !this.stopped) {
        const g = new Git(existsSync(wt) ? wt : this.root);
        await this.park(t, r, g, `internal error: ${String(e).slice(0, 500)}`).catch(() => {});
      }
    } finally {
      clearInterval(hb);
      if (existsSync(wt)) await this.removeWorktree(wt).catch(() => {});
    }
  }

  /** Squash onto the night branch and push (never force). Retries when another node merged first. */
  private async merge(t: Task, r: Running, g: Git, base: string): Promise<string | null> {
    const msg = `${t.id}: ${t.title}\n\nNightshift-Task: ${t.id}\nNightshift-Node: ${this.me.id}\nNightshift-Lane: ${t.lane}`;
    await g.ok(["reset", "--soft", base]);
    await g.ok(["commit", "-q", "--no-verify", "--allow-empty", "-m", msg]);
    for (let attempt = 0; attempt < 8 && !r.lost && !this.stopped; attempt++) {
      const head = await this.fetchNight();
      const already = await this.git.raw(["log", "--format=%(trailers:key=Nightshift-Task,valueonly)", head]);
      if (already.stdout.split("\n").some((x) => x.trim() === t.id)) {
        this.ledger.add("merge_skipped", { task: t.id, data: { reason: "already on the night branch" } });
        r.lost = true;
        return null;
      }
      if (head !== base) {
        const rb = await g.raw(["rebase", head]);
        if (rb.code !== 0) {
          // Leases make conflicts rare (only when a contract or lease request touched our files). Let a fixer resolve it.
          r.phase = "resolving conflict";
          const res = await this.runAgent({
            role: "fixer",
            task: t,
            cwd: g.cwd,
            readOnly: false,
            running: r,
            prompt: `A rebase of task ${t.id} onto the latest night branch stopped with conflicts.\n\n${tail(rb.stdout + rb.stderr, 4000)}\n\nResolve every conflict marker in the conflicted files (keep both sides' intent; other tasks' merged work wins on files outside your lease), then run \`git add -A\` and \`git -c core.editor=true rebase --continue\`. Do not abort the rebase.`,
          });
          const stillRebasing = existsSync(join(g.cwd, ".git")) && (await g.raw(["rev-parse", "--verify", "--quiet", "REBASE_HEAD"])).code === 0;
          if (!res.ok || stillRebasing) {
            await g.raw(["rebase", "--abort"]);
            await this.park(t, r, g, "rebase conflict could not be resolved automatically");
            return null;
          }
        }
        base = head;
        r.phase = "re-checking";
        const lease = await this.enforceLease(t, g, base);
        const checks = await this.runChecks(t, g.cwd);
        if (!checks.ok || lease.length) {
          await this.park(t, r, g, `checks failed after rebasing onto newer night work:\n${checks.output}`);
          return null;
        }
        // Keep one commit per task.
        await g.ok(["reset", "--soft", base]);
        await g.ok(["commit", "-q", "--no-verify", "--allow-empty", "-m", msg]);
      }
      const pushed = await this.remoteLock.run(() => g.raw(["push", "--quiet", this.cfg.remote, `HEAD:refs/heads/${this.branch}`]));
      if (pushed.code === 0) return await g.ok(["rev-parse", "HEAD"]);
      this.ledger.add("merge_retry", { task: t.id, data: { attempt, stderr: pushed.stderr.slice(0, 300) } });
      await sleep(200 + Math.random() * 800);
    }
    if (!r.lost && !this.stopped) await this.park(t, r, g, "could not merge after 8 attempts (night branch kept moving)");
    return null;
  }

  private async finishDone(t: Task, r: Running, merge: string, files: string[]) {
    r.phase = "done";
    const ok = await this.transitionMine(t, r, { status: "done", node: this.me.id, attempt: r.attempt, merge, since: r.startedAt });
    if (!ok) this.ledger.add("error", { task: t.id, data: { where: "finishDone", error: "could not record done state" } });
    this.merges++;
    this.ledger.add("task_done", { task: t.id, data: { merge, cost: r.cost, files } });
    await this.post("task_done", `Merged ${t.id}: ${t.title} (${merge.slice(0, 8)}) in ${Math.round((Date.now() - r.startedAt) / 60000)} min${this.agent === "codex" ? "" : this.cfg.auth === "subscription" ? `, est. usage $${r.cost.toFixed(2)} (subscription, not billed)` : `, $${r.cost.toFixed(2)}`}.`, {
      task: t.id,
      body: { merge, cost: r.cost, files: files.slice(0, 50), lane: t.lane, stolen: r.stolen },
    });
  }

  private async park(t: Task, r: Running, g: Git, why: string) {
    r.phase = "parked";
    // Keep the work for the morning: push the task branch (a new branch name, never a force).
    let kept = "";
    if (g.cwd !== this.root) {
      await g.commitAll(`${t.id}: parked work`).catch(() => false);
      const ref = `refs/heads/ns/${this.night}/${t.id}-a${r.attempt}`;
      const p = await this.remoteLock.run(() => g.raw(["push", "--quiet", this.cfg.remote, `HEAD:${ref}`]));
      if (p.code === 0) kept = ref.replace("refs/heads/", "");
    }
    await this.transitionMine(t, r, { status: "parked", node: this.me.id, attempt: r.attempt, note: why.slice(0, 1500), since: r.startedAt });
    this.ledger.add("task_parked", { task: t.id, data: { why, branch: kept, cost: r.cost } });
    await this.post("task_parked", `Parked ${t.id} (${t.title}) for the morning: ${why.slice(0, 250)}`, {
      task: t.id,
      body: { why: why.slice(0, 3000), branch: kept, cost: r.cost, lane: t.lane },
    });
  }

  private async maybeGate() {
    const gate = this.cfg.gate;
    if (!gate || this.merges % gate.every !== 0) return;
    const wt = join(this.local, "wt", "_gate");
    const head = await this.fetchNight();
    await this.freshWorktree(wt, head, null);
    const res = await sh(gate.command, { cwd: wt, timeoutMs: this.cfg.limits.command_timeout_seconds * 1000 });
    await this.removeWorktree(wt).catch(() => {});
    this.ledger.add("gate", { data: { head, code: res.code } });
    if (res.code === 0) {
      await this.post("gate_passed", `Integration gate passed at ${head.slice(0, 8)}.`, { body: { head } });
      return;
    }
    await this.post("gate_failed", `Integration gate FAILED at ${head.slice(0, 8)}. Queuing a fixer.`, { body: { head, text: tail(res.stdout + res.stderr, 2000) } });
    const openFix = this.tasks.some((t) => t.id.startsWith("FIX-") && !["done", "parked"].includes(this.states.get(t.id)?.state.status ?? ""));
    if (openFix) return;
    const recent = await this.git.ok(["log", "--format=%h %s", "-n", "8", this.remoteNight()]).catch(() => "");
    const id = `FIX-${this.me.id}-${Date.now().toString(36)}`;
    await this.addDynamicTask(
      {
        id,
        title: "Repair the integration gate",
        lane: this.cfg.contract_lane ?? this.me.lanes[0],
        role: "fixer",
        brief: `The integration gate \`${gate.command}\` fails on the night branch at ${head.slice(0, 8)}.\n\nRecent merges:\n${recent}\n\nOutput:\n${tail(res.stdout + res.stderr, 6000)}\n\nFind the cause and make the gate pass with the smallest correct change. Do not delete or skip tests.`,
        lease: ["**"],
        depends_on: [],
        contracts: this.cfg.contracts,
        acceptance: [gate.command],
      },
      `Gate failed; queued ${id}. It reserves the whole tree, so new work waits until it lands.`,
    );
  }

  // ---------- subscription usage limits ----------

  paused(): boolean {
    return Date.now() < this.pausedUntil;
  }

  private emptyGhDir(): string {
    const d = join(this.local, "agent-gh-config");
    mkdirSync(d, { recursive: true });
    return d;
  }

  /** The plan's window is used up: stop taking tasks until it resets, abort agents that would fail anyway. */
  pauseForUsage(resumeAt?: number) {
    const until = Math.max(resumeAt ?? 0, Date.now() + 60_000);
    const target = resumeAt ? until : Date.now() + this.cfg.usage_limit_pause_minutes * 60_000;
    if (target <= this.pausedUntil) return;
    this.pausedUntil = target;
    this.usage = { ...(this.usage ?? {}), status: "limited", resetsAt: target };
    this.ledger.add("paused", { data: { until: target } });
    void this.post("note", `${this.me.name}'s ${this.agent === "codex" ? "Codex" : "Claude"} plan hit its usage limit. Pausing until ${new Date(target).toLocaleTimeString()}; releasing running tasks to other nodes.`, {
      body: { text: "usage limit", paused_until: target },
    });
    for (const r of this.running.values()) r.abort.abort();
  }

  /** Hand a task back to the team without counting it as a failure. */
  private async release(t: Task, r: Running, why: string) {
    r.phase = "released";
    await this.transitionMine(t, r, { status: "open", node: this.me.id, attempt: r.attempt, note: why, since: r.startedAt });
    this.ledger.add("task_released", { task: t.id, data: { why } });
    await this.post("task_released", `Released ${t.id} (${t.title}): ${why}. Another node can take it.`, { task: t.id, body: { why, lane: t.lane } });
  }

  // ---------- snapshot for the dashboard ----------

  snapshot() {
    const r = this.readinessNow();
    return {
      node: this.me,
      nodes: this.cfg.nodes,
      night: this.night,
      branch: this.branch,
      project: this.cfg.project,
      adapter: this.adapter.name,
      stopped: this.stopped,
      stopReason: this.stopReason,
      finished: this.finished,
      budget: this.cfg.budget,
      spent: Object.fromEntries(this.spentByNode),
      merges: this.merges,
      agent: this.agent,
      auth: this.cfg.auth,
      pausedUntil: this.pausedUntil,
      usage: Object.fromEntries(this.usageByNode),
      tasks: this.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        lane: t.lane,
        role: t.role,
        depends_on: t.depends_on,
        lease: t.lease,
        readiness: r.get(t.id),
        state: this.states.get(t.id)?.state ?? null,
      })),
      running: [...this.running.values()].map(({ abort: _a, inbox, claimSha: _c, ...x }) => ({ ...x, inboxWaiting: inbox.length })),
    };
  }
}

export function makeBoard(cfg: NightConfig, root: string, cursorPath: string): Board {
  if (cfg.board.kind === "file") return new FileBoard(join(root, cfg.board.path), cursorPath);
  const repo = cfg.board.repo ?? repoFromRemote(root, cfg.remote);
  return new GitHubIssueBoard(repo, cfg.board.issue, cursorPath);
}

function repoFromRemote(root: string, remote: string): string {
  try {
    const cfgText = readFileSync(join(root, ".git", "config"), "utf8");
    const m = new RegExp(`\\[remote "${remote}"\\][^\\[]*url = (.+)`).exec(cfgText);
    const url = m?.[1].trim() ?? "";
    const path = url.replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "");
    if (/^[\w.-]+\/[\w.-]+$/.test(path)) return path;
  } catch {
    /* fall through */
  }
  throw new Error("board.repo is not set and the GitHub repo cannot be read from the remote URL");
}

/** The repo's own agent guide (AGENTS.md / CLAUDE.md), inlined because settings are not loaded. */
function projectGuide(cwd: string): string {
  const out: string[] = [];
  for (const f of ["AGENTS.md", "CLAUDE.md"]) {
    const p = join(cwd, f);
    if (existsSync(p)) out.push(`# Project guide: ${f}\n${readFileSync(p, "utf8").slice(0, 12_000)}`);
  }
  return out.join("\n\n");
}

function summarizeInput(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const o = input as Record<string, unknown>;
  return { command: o.command, file_path: o.file_path, path: o.path, pattern: o.pattern };
}

export { run };

class UsageLimitHit extends Error {
  constructor() {
    super("usage limit");
  }
}
