// Structured board messages. Each post is one readable line for humans plus a fenced
// JSON envelope for agents, so routing never depends on parsing prose.
//
//   [Ethan's Relay] T3 merged: Shift A create screen (a1b2c3d)
//
//   ```relay
//   {"v":1,"from":"ethan","to":"*","type":"task_done","task":"T3","body":{...},"at":1731300000000}
//   ```
import { z } from "zod";

export const EnvelopeType = z.enum([
  "ready", // a teammate's computer passed its checks
  "go", // "start the run for everyone"
  "node_up",
  "node_down",
  "note",
  "ask",
  "answer",
  "assumption",
  "blocker",
  "lease_request",
  "contract_change",
  "task_claimed",
  "task_done",
  "task_parked",
  "task_released",
  "task_added",
  "gate_passed",
  "gate_failed",
  "budget",
  "stop",
  "alert", // a real problem; the human line @mentions the lead so GitHub notifies their phone
  "reserve", // path globs humans are working on (agents keep out)
]);
export type EnvelopeType = z.infer<typeof EnvelopeType>;

export const Envelope = z.object({
  v: z.literal(1),
  from: z.string(), // node id
  // "*" | "node:<id>" | "lane:<lane>" | "task:<id>"
  to: z.string().default("*"),
  type: EnvelopeType,
  task: z.string().optional(),
  body: z.record(z.string(), z.unknown()).prefault({}),
  at: z.number(),
  runId: z.string().optional(),
});
export type Envelope = z.infer<typeof Envelope>;

export interface BoardMessage {
  id: string; // board-assigned, monotonically increasing per board
  author: string; // GitHub login or "file"
  createdAt: string;
  updatedAt?: string;
  text: string; // full raw text
  env?: Envelope; // parsed envelope, if any
}

const FENCE = /```relay\s*\n([\s\S]*?)\n```/;

export function formatPost(human: string, env: Envelope): string {
  return `${human}\n\n\`\`\`relay\n${JSON.stringify(env)}\n\`\`\``;
}

export function parseEnvelope(text: string): Envelope | undefined {
  const m = FENCE.exec(text);
  if (!m) return undefined;
  try {
    const r = Envelope.safeParse(JSON.parse(m[1]));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

/** A human (or anyone) can halt the run by posting a line that starts with "relay stop". */
export function isStopText(text: string): boolean {
  return /^\s*(\[[^\]]*\]\s*)?relay\s+stop\b/im.test(text);
}

/** Does this envelope concern a worker running `task` in `lane` on `node`? */
export function addressedTo(env: Envelope, t: { node: string; lane?: string; task?: string }): boolean {
  if (env.to === "*") return true;
  if (env.to === `node:${t.node}`) return true;
  if (t.lane && env.to === `lane:${t.lane}`) return true;
  if (t.task && env.to === `task:${t.task}`) return true;
  return false;
}

/** The human line that goes first in every post, keeping the old `[<human>'s <agent>]` rule. */
export function humanLine(nodeName: string, text: string): string {
  return `[${nodeName}'s Relay] ${text}`.slice(0, 600);
}
