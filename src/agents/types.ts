import type { Task } from "../config.js";

export type Role = "builder" | "fixer" | "contract" | "reviewer" | "answerer" | "planner";

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
  kind: "text" | "tool" | "denied" | "result" | "error" | "inbox";
  text?: string;
  tool?: string;
  input?: unknown;
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
  signal?: AbortSignal;
  /** Extra data for the fake adapter (tests, rehearsals). */
  fake?: Record<string, unknown>;
}

export interface AgentResult {
  ok: boolean;
  reason?: "timeout" | "stuck" | "error" | "max_turns" | "budget" | "aborted";
  text: string;
  costUsd: number;
  sessionId?: string;
  denials: number;
}

export interface Adapter {
  name: string;
  run(req: AgentRequest): Promise<AgentResult>;
}
