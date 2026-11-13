// Types mirror src/server.ts, src/setup.ts and src/daemon.ts snapshot().
export type Readiness = "done" | "parked" | "running" | "stale" | "ready" | "waiting" | "blocked";
export type OS = "mac" | "windows" | "linux";
export type Agent = "claude" | "codex";

export interface Member {
  id: string;
  name: string;
  github: string;
  os: OS;
  agent: Agent;
  roles: string;
  model?: string;
}
export interface SetupData {
  version: 1;
  event: { name: string; track: string; deadline: string; links: string };
  idea: { pitch: string; problem: string; demo: string; must: string; nice: string; stack: string; rules: string };
  team: Member[];
  rules: { perComputer: number; usageCap: number; review: boolean; stealing: boolean; contractsOwner: string; check: string; alerts: boolean; stopBefore: number };
}
export interface AppState {
  project: { path: string; name: string; hasSetup: boolean; tasks: number; hasCommits: boolean; unshared: number } | null;
  recent: string[];
  me: string | null;
  setup: SetupData | null;
  board: { kind: string; issue: number | null; repo: string | null } | null;
  night: string | null;
  running: number | null;
  live: boolean;
  autoStart: boolean;
  home: string;
  sep: string;
}
export interface Tools {
  os: OS;
  node: string;
  git: boolean;
  bash: boolean;
  gh: boolean;
  ghLogin: string | null;
  claude: { installed: boolean; loggedIn: boolean; subscription: boolean };
  codex: { installed: boolean; loggedIn: boolean; subscription: boolean };
}
export interface Task {
  id: string;
  title: string;
  lane: string;
  role?: string;
  brief?: string;
  lease: string[];
  depends_on?: string[];
  contracts?: string[];
  acceptance?: string[];
  priority?: "must" | "nice";
  retry_of?: string;
}
export interface TaskState {
  status: "claimed" | "done" | "parked" | "open";
  node: string;
  at: number;
  attempt: number;
  note?: string;
  merge?: string;
}
export interface TaskRow extends Task {
  depends_on: string[];
  readiness: Readiness;
  state: TaskState | null;
}
export interface Envelope {
  from: string;
  to: string;
  type: string;
  task?: string;
  body: Record<string, unknown>;
  at: number;
  night?: string;
}
export interface BoardRow {
  id: string;
  author: string;
  createdAt: string;
  text: string;
  env?: Envelope;
}
export interface UsageInfo {
  status: "allowed" | "warning" | "limited";
  utilization?: number;
  window?: string;
  resetsAt?: number;
}
export interface RunningRow {
  task: string;
  title: string;
  lane: string;
  role: string;
  phase: string;
  startedAt: number;
  lastActivity: number;
  lastText: string;
  cost: number;
}
export interface NodeSpec {
  id: string;
  name: string;
  lanes: string[];
  agent?: Agent;
}
export interface Snapshot {
  node: NodeSpec;
  nodes: NodeSpec[];
  night: string;
  branch: string;
  project: string;
  stopped: boolean;
  stopReason: string;
  finished: boolean;
  budget: { node_usd: number; team_usd: number };
  spent: Record<string, number>;
  agent: Agent | "fake";
  auth: "subscription" | "api_key";
  pausedUntil: number;
  authLost?: boolean;
  day?: boolean;
  reserves?: Record<string, string[]>;
  cutoffAt?: number | null;
  deadline?: string | null;
  usage: Record<string, UsageInfo>;
  tasks: TaskRow[];
  running: RunningRow[];
  live: boolean;
  daemonPid: number | null;
  board: BoardRow[];
}
export interface Check {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { ...init, headers: { "content-type": "application/json" } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string }).error ?? r.statusText);
  return body as T;
}
const post = <T,>(path: string, body?: unknown) => req<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });

export const api = {
  app: () => req<AppState>("/api/app"),
  tools: (refresh = false) => (refresh ? post<Tools>("/api/tools/refresh") : req<Tools>("/api/tools")),
  open: (path: string) => post<{ path: string }>("/api/project/open", { path }),
  create: (name: string, parent: string, description: string) => post<{ path: string }>("/api/project/create", { name, parent, description }),
  clone: (url: string, parent: string) => post<{ path: string }>("/api/project/clone", { url, parent }),
  pull: () => post("/api/project/pull"),
  close: () => post("/api/project/close"),
  practice: () => post("/api/practice"),
  saveSetup: (s: SetupData) => req<{ setup: SetupData }>("/api/setup", { method: "PUT", body: JSON.stringify(s) }),
  setMe: (node: string) => post("/api/me", { node }),
  autofill: (markdown: string, current: SetupData, ai: boolean) => post<{ setup: SetupData; filled: string[]; usedAI: boolean; aiError?: string }>("/api/setup/autofill", { markdown, current, ai }),
  plan: (agent: Agent) => post("/api/plan", { agent }),
  planStatus: () => req<{ running: boolean; log: string[]; ok?: boolean; error?: string }>("/api/plan"),
  tasks: () => req<{ yaml: string; tasks: Task[] }>("/api/tasks"),
  saveTasks: (b: { tasks?: Task[]; yaml?: string }) => req("/api/tasks", { method: "PUT", body: JSON.stringify(b) }),
  sharePreview: () => req<{ files: string[]; repo: string | null }>("/api/share"),
  share: () => post<{ steps: string[]; repo: string; link: string }>("/api/share"),
  invite: (github: string) => post<{ note: string }>("/api/invite", { github }),
  onboarding: () => req<{ repo: string; prompts: { id: string; name: string; os: OS; agent: Agent; markdown: string }[] }>("/api/onboarding"),
  preflight: (live: boolean) => req<{ checks: Check[]; ok: boolean; posted: boolean }>(`/api/preflight?live=${live ? 1 : 0}`, { method: "POST" }),
  autostart: (on: boolean) => post("/api/autostart", { on }),
  start: (everyone: boolean, day = false) => post("/api/start", { everyone, day }),
  reserve: (globs: string[]) => post<{ globs: string[] }>("/api/reserve", { globs }),
  retry: (task: string, hint: string) => post<{ id: string }>("/api/retry", { task, hint }),
  draftSubmission: () => post<{ markdown: string; sections: { title: string; body: string }[] }>("/api/submission"),
  commitSubmission: (markdown: string) => post<{ sha: string }>("/api/submission/commit", { markdown }),
  stop: (team: boolean) => req(`/api/stop?team=${team ? 1 : 0}`, { method: "POST" }),
  snapshot: () => req<Snapshot>("/api/snapshot"),
  report: () => req<{ markdown: string; file: string }>("/api/report"),
  openPr: () => post<{ url: string }>("/api/report/pr"),
};

export const EMPTY_SETUP: SetupData = {
  version: 1,
  event: { name: "", track: "", deadline: "", links: "" },
  idea: { pitch: "", problem: "", demo: "", must: "", nice: "", stack: "", rules: "" },
  team: [],
  rules: { perComputer: 2, usageCap: 25, review: true, stealing: true, contractsOwner: "", check: "", alerts: true, stopBefore: 120 },
};
