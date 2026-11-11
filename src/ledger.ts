// Local, append-only record of everything this node did or saw. Feeds the dashboard (live,
// over SSE) and the morning report. Never shared directly: the board and git refs are shared.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { EventEmitter } from "node:events";

export interface LedgerEvent {
  at: number;
  node: string;
  kind: string; // e.g. agent_text, tool, denied, task_claimed, task_done, board, cost, error
  task?: string;
  role?: string;
  data?: Record<string, unknown>;
}

export class Ledger extends EventEmitter {
  private recent: LedgerEvent[] = [];
  constructor(private file: string, private node: string, private keep = 2000) {
    super();
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      for (const l of readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-keep)) {
        try {
          this.recent.push(JSON.parse(l));
        } catch {
          /* torn last line after a crash */
        }
      }
    }
  }
  add(kind: string, fields: Omit<LedgerEvent, "at" | "node" | "kind"> = {}): LedgerEvent {
    const e: LedgerEvent = { at: Date.now(), node: this.node, kind, ...fields };
    appendFileSync(this.file, JSON.stringify(e) + "\n");
    this.recent.push(e);
    if (this.recent.length > this.keep) this.recent.splice(0, this.recent.length - this.keep);
    this.emit("event", e);
    return e;
  }
  tail(n = 300): LedgerEvent[] {
    return this.recent.slice(-n);
  }
  all(): LedgerEvent[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as LedgerEvent];
        } catch {
          return [];
        }
      });
  }
}
