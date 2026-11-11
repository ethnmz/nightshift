// Types mirror src/daemon.ts snapshot() and src/server.ts responses.
export type Readiness = "done" | "parked" | "running" | "stale" | "ready" | "waiting" | "blocked";

export interface NodeSpec {
  id: string;
  name: string;
  login?: string;
  lanes: string[];
}
export interface TaskState {
  status: "claimed" | "done" | "parked";
  node: string;
  at: number;
  attempt: number;
  note?: string;
  merge?: string;
  since?: number;
}
export interface TaskRow {
  id: string;
  title: string;
  lane: string;
  role: string;
  depends_on: string[];
  lease: string[];
  readiness: Readiness;
  state: TaskState | null;
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
  attempt: number;
  stolen: boolean;
  inboxWaiting: number;
}
export interface Envelope {
  from: string;
  to: string;
  type: string;
  task?: string;
  body: Record<string, unknown>;
  at: number;
}
export interface BoardRow {
  id: string;
  author: string;
  createdAt: string;
  text: string;
  env?: Envelope;
}
export interface LedgerEvent {
  at: number;
  node: string;
  kind: string;
  task?: string;
  role?: string;
  data?: Record<string, unknown>;
}
export interface Snapshot {
  node: NodeSpec;
  nodes: NodeSpec[];
  night: string;
  branch: string;
  project: string;
  adapter: string;
  stopped: boolean;
  stopReason: string;
  finished: boolean;
  budget: { node_usd: number; team_usd: number };
  spent: Record<string, number>;
  merges: number;
  tasks: TaskRow[];
  running: RunningRow[];
  live: boolean;
  daemonPid: number | null;
  board: BoardRow[];
  ledger: LedgerEvent[];
}
export interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { errors?: string[]; error?: string }).errors?.join("\n") ?? (body as { error?: string }).error ?? r.statusText);
  return body as T;
}

export const api = {
  snapshot: () => req<Snapshot>("/api/snapshot"),
  plan: () => req<{ night: string; tasks: string; idea: string }>("/api/plan"),
  savePlan: (b: { night?: string; tasks?: string; idea?: string }) => req<{ ok: boolean; note: string }>("/api/plan", { method: "PUT", body: JSON.stringify(b) }),
  preflight: (live: boolean) => req<CheckResult[]>(`/api/preflight?live=${live ? 1 : 0}`, { method: "POST" }),
  start: () => req<{ ok: boolean; pid: number }>("/api/start", { method: "POST" }),
  stop: (team: boolean) => req<{ ok: boolean }>(`/api/stop?team=${team ? 1 : 0}`, { method: "POST" }),
  report: () => req<{ markdown: string; file: string }>("/api/report"),
};
