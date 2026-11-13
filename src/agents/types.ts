import type { Task } from "../config.js";

export type Role = "builder" | "fixer" | "contract" | "reviewer" | "answerer" | "planner" | "writer";

/** The tools every worker gets through the in-process `nightshift` MCP server. None of them asks a human. */
export interface NightshiftTools {
  post_note(a: { to?: string; text: string }): Promise<string>;
  ask(a: { to: string; question: string }): Promise<string>;
  answer(a: { to: string; text: string; question_id?: string }): Promise<string>;
  check_board(): Promise<string>;
  record_assumption(a: { decision: string; why: string }): Promise<string>;
  report_blocker(a: { kind: string; detail: string }): Promise<string>;
  request_contract_change(a: { file: string; change: string; reason: string }): Promise<string>;
  submit_review(a: { verdict: "approve" | "changes"; notes: string }): Promise<string>;
}

export interface AgentEvent {
  kind: "text" | "tool" | "denied" | "result" | "error" | "inbox" | "usage";
  usage?: UsageInfo;
  text?: string;
  tool?: string;
  input?: unknown;
}

/** Subscription usage as the agent reports it (Claude: rate_limit_event; Codex: error text). */
export interface UsageInfo {
  status: "allowed" | "warning" | "limited";
  utilization?: number; // 0..1 when known
  window?: string; // e.g. five_hour, seven_day
  resetsAt?: number; // ms epoch
}

export interface AgentRequest {
  role: Role;
  task?: Task;
  cwd: string;
  system: string;
  prompt: string;
  model?: string;
  maxTurns: number;
  timeoutMs: number;
  stuckMs: number;
  maxBudgetUsd?: number;
  allowCommands: string[];
  readOnly: boolean;
  tools: NightshiftTools;
  /** Drains messages that arrived for this worker since the last call (board → worker). */
  inbox: () => string[];
  onEvent: (e: AgentEvent) => void;
  resume?: string;
  env?: Record<string, string>;
  /** Env vars to remove for the agent process (API keys in subscription mode). */
  removeEnv?: string[];
  signal?: AbortSignal;
  /** Extra data for the fake adapter (tests, rehearsals). */
  fake?: Record<string, unknown>;
}

export interface AgentResult {
  ok: boolean;
  reason?: "timeout" | "stuck" | "error" | "max_turns" | "budget" | "aborted" | "usage_limit" | "auth";
  /** When reason is usage_limit: when the plan's window resets (ms epoch), if reported. */
  resumeAt?: number;
  text: string;
  costUsd: number;
  sessionId?: string;
  denials: number;
}

export interface Adapter {
  name: string;
  run(req: AgentRequest): Promise<AgentResult>;
}
