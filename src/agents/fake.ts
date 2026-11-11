// A deterministic stand-in for a model. It drives the full pipeline (claims, leases,
// checks, review, merge, board traffic) with no API spend, for tests and rehearsals.
//
// Task-level `fake:` keys (all optional):
//   writes:   { "path": "content" }         files to write into the worktree
//   sleep_ms: number                         pretend to work
//   fail:     true | "first"                 return a failed run (always, or only on attempt 1)
//   stuck:    true                           hang until aborted (exercises the watchdog)
//   assume:   "text"                         call record_assumption
//   ask:      { to, question }               call ask
//   note:     { to, text }                   call post_note
//   review:   "approve" | "changes-once" | "changes"
//   cost:     number                         reported USD per run (default 0.01)
//   wait_inbox_ms: number                    poll the inbox for this long; writes what arrived to `inbox_file`
//   inbox_file: "path"                       (inside the lease) where received messages are saved
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Adapter, AgentRequest, AgentResult } from "./types.js";

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      res();
    });
  });

export class FakeAdapter implements Adapter {
  name = "fake";
  private runs = new Map<string, number>();

  async run(req: AgentRequest): Promise<AgentResult> {
    const f = (req.fake ?? {}) as Record<string, any>;
    const key = `${req.task?.id ?? "-"}:${req.role}`;
    const n = (this.runs.get(key) ?? 0) + 1;
    this.runs.set(key, n);
    const cost = typeof f.cost === "number" ? f.cost : 0.01;
    const done = (ok: boolean, text: string, reason?: AgentResult["reason"]): AgentResult => {
      req.onEvent({ kind: "result", text });
      return { ok, text, reason, costUsd: cost, denials: 0, sessionId: `fake-${key}-${n}` };
    };

    if (req.role === "reviewer") {
      const mode = f.review ?? "approve";
      const verdict = mode === "changes" || (mode === "changes-once" && n === 1) ? "changes" : "approve";
      await req.tools.submit_review({ verdict, notes: verdict === "approve" ? "LGTM" : "Please add the missing test." });
      return done(true, `review ${verdict}`);
    }
    if (req.role === "answerer") {
      return done(true, `Fake answer from ${req.task?.lane ?? "lane"}: use the contract as written.`);
    }
    if (req.role === "planner") return done(true, "planner not available in fake mode");

    req.onEvent({ kind: "text", text: `fake ${req.role} working on ${req.task?.id}` });
    if (f.stuck) {
      // Simulate a hung process: no events until the watchdog aborts us.
      await new Promise<void>((res) => req.signal?.addEventListener("abort", () => res()));
      return done(false, "aborted", "stuck");
    }
    if (f.sleep_ms) await sleep(Number(f.sleep_ms), req.signal);
    if (req.signal?.aborted) return done(false, "aborted", "aborted");
    if (f.fail === true || (f.fail === "first" && n === 1)) return done(false, "fake failure", "error");
    if (f.assume) await req.tools.record_assumption({ decision: String(f.assume), why: "fake adapter" });
    if (f.note) await req.tools.post_note(f.note);
    if (f.ask) await req.tools.ask(f.ask);

    for (const [p, content] of Object.entries((f.writes ?? {}) as Record<string, string>)) {
      const abs = join(req.cwd, p);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, req.role === "fixer" ? `${content}\n// fixed\n` : content);
      req.onEvent({ kind: "tool", tool: "Write", input: { file_path: p } });
    }

    if (f.wait_inbox_ms && f.inbox_file) {
      const got: string[] = [];
      const until = Date.now() + Number(f.wait_inbox_ms);
      while (Date.now() < until && !req.signal?.aborted) {
        got.push(...req.inbox());
        if (got.length) break;
        await sleep(100, req.signal);
      }
      const abs = join(req.cwd, String(f.inbox_file));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, got.join("\n") + "\n");
    }
    return done(true, `fake ${req.role} finished`);
  }
}
