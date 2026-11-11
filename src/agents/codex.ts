// OpenAI Codex CLI, headless (`codex exec --json`), on the teammate's own ChatGPT-plan login.
// Overnight guarantees:
//  - approval_policy="never": Codex never stops to ask; a command its sandbox refuses just fails.
//  - Sandbox: workspace-write (only the task worktree is writable), read-only for reviewer/answerer.
//  - Network is on for package installs; pushes are blocked by the guard env (push URL points nowhere)
//    and `gh` sees an empty config dir.
//  - Codex has no in-process tool hooks, so the nightshift tools are a file mailbox in the worktree:
//      .nightshift-mail/outbox.jsonl   agent → team (one JSON object per line), or out/*.json files
//      .nightshift-mail/inbox.md       team → agent (appended live while it works)
//    The folder ignores itself (.gitignore "*"), so it never reaches a commit or a lease check.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { childEnv } from "../exec.js";
import { IS_WIN, killTree, resolveCli } from "../platform.js";
import type { Adapter, AgentRequest, AgentResult, NightshiftTools } from "./types.js";

export const MAILDIR = ".nightshift-mail";

const TOOL_NAMES = ["post_note", "ask", "answer", "record_assumption", "report_blocker", "request_contract_change", "submit_review"] as const;

function toolsGuide(readOnly: boolean): string {
  if (readOnly)
    return `## Reporting back
You are read-only and cannot write files. Put everything in your final message.
If you are reviewing, end your final message with exactly one line: \`VERDICT: approve\` or \`VERDICT: changes\`, followed by your notes.`;
  return `## Team tools (file mailbox — the only way to reach other agents tonight)
Send by appending ONE JSON object per line to \`${MAILDIR}/outbox.jsonl\`, for example:
  printf '%s\\n' '{"tool":"record_assumption","decision":"Use SQLite WAL mode","why":"brief does not say"}' >> ${MAILDIR}/outbox.jsonl
(Or create a file \`${MAILDIR}/out/<any-name>.json\` holding one such object.)
Tools and fields:
- record_assumption {decision, why} — REQUIRED whenever you decide something unspecified
- ask {to, question} — to "lane:<lane>"; returns nothing; do not wait, assume and continue
- post_note {to, text} · answer {to, text, question_id} · report_blocker {kind, detail}
- request_contract_change {file, change, reason}
Messages from the team are appended to \`${MAILDIR}/inbox.md\`. Read it between steps and before you finish.
Do not commit or push; Nightshift commits, reviews and merges your work.`;
}

/** Best-effort reset time from a usage-limit message ("try again in 2 hours", "try again at 3:05 AM"). */
export function parseResetTime(text: string, now = Date.now()): number | undefined {
  const rel = /try again in\s+(?:about\s+)?(\d+)\s*(second|minute|hour|day)s?/i.exec(text);
  if (rel) {
    const unit = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5 }[rel[2].toLowerCase() as "second"]!;
    return now + Number(rel[1]) * unit;
  }
  const abs = /try again at\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(text);
  if (abs) {
    let h = Number(abs[1]) % 12;
    if (abs[3]?.toLowerCase() === "pm") h += 12;
    if (!abs[3]) h = Number(abs[1]);
    const d = new Date(now);
    d.setHours(h, Number(abs[2]), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return undefined;
}

const LIMIT_RE = /usage limit|rate limit|hit your limit|quota exceeded|too many requests/i;

export class CodexAdapter implements Adapter {
  name = "codex";
  private cmd: [string, string[]];
  constructor(bin?: string) {
    this.cmd = resolveCli("codex", bin);
  }

  async run(req: AgentRequest): Promise<AgentResult> {
    const mail = join(req.cwd, MAILDIR);
    rmSync(mail, { recursive: true, force: true });
    mkdirSync(join(mail, "out"), { recursive: true });
    writeFileSync(join(mail, ".gitignore"), "*\n");
    writeFileSync(join(mail, "outbox.jsonl"), "");
    writeFileSync(join(mail, "inbox.md"), "# Team messages\n");
    const lastFile = join(mail, "last-message.txt");

    const prompt = `${req.system}\n\n${toolsGuide(req.readOnly)}\n\n${req.prompt}`;
    // Codex fix rounds start fresh: the fixer prompt carries the failure, which keeps this robust.
    const args = [
      "exec",
      "--json",
      "-C", req.cwd,
      "-s", req.readOnly ? "read-only" : "workspace-write",
      "-c", 'approval_policy="never"',
      "-c", "sandbox_workspace_write.network_access=true",
      "-c", 'shell_environment_policy.inherit="all"',
      "--skip-git-repo-check",
      "-o", lastFile,
      ...(req.model ? ["-m", req.model] : []),
      "-",
    ];

    let sessionId: string | undefined;
    let lastText = "";
    let failure = "";
    let limited = false;
    let resumeAt: number | undefined;
    let outboxSeen = 0;
    const handled = new Set<string>();

    const pump = async () => {
      // agent → team
      const lines = readFileSync(join(mail, "outbox.jsonl"), "utf8").split("\n");
      const fresh = lines.slice(outboxSeen, lines.length - 1);
      outboxSeen += fresh.length;
      const files = existsSync(join(mail, "out")) ? readdirSync(join(mail, "out")).filter((f) => f.endsWith(".json") && !handled.has(f)) : [];
      const items = [...fresh.map((l) => ({ src: "outbox", raw: l })), ...files.map((f) => ({ src: f, raw: readFileSync(join(mail, "out", f), "utf8") }))];
      for (const f of files) handled.add(f);
      for (const it of items) {
        try {
          const o = JSON.parse(it.raw) as { tool?: string } & Record<string, string>;
          if (!o.tool || !(TOOL_NAMES as readonly string[]).includes(o.tool)) throw new Error(`unknown tool ${o.tool}`);
          req.onEvent({ kind: "tool", tool: `mailbox:${o.tool}`, input: o });
          const fn = req.tools[o.tool as keyof NightshiftTools] as (a: unknown) => Promise<string>;
          await fn(o);
        } catch (e) {
          appendFileSync(join(mail, "inbox.md"), `\n[nightshift] Could not read a mailbox entry (${String(e).slice(0, 120)}). Use one JSON object per line.\n`);
        }
      }
      // team → agent
      const msgs = req.inbox();
      if (msgs.length) {
        appendFileSync(join(mail, "inbox.md"), `\n## ${new Date().toLocaleTimeString()}\n${msgs.join("\n")}\n`);
        req.onEvent({ kind: "inbox", text: msgs.join("\n") });
      }
    };

    const code = await new Promise<number>((resolve) => {
      const child = spawn(this.cmd[0], [...this.cmd[1], ...args], {
        cwd: req.cwd,
        env: childEnv(req.env, req.removeEnv),
        stdio: ["pipe", "pipe", "pipe"],
        detached: !IS_WIN,
        windowsHide: true,
      });
      const kill = () => killTree(child.pid);
      req.signal?.addEventListener("abort", kill);
      const timer = setTimeout(kill, req.timeoutMs);
      const poll = setInterval(() => void pump().catch(() => {}), 1000);
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
      let buf = "";
      child.stdout.on("data", (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev: Record<string, any>;
          try {
            ev = JSON.parse(line);
          } catch {
            req.onEvent({ kind: "text", text: line.slice(0, 500) });
            continue;
          }
          const item = ev.item ?? {};
          if (ev.type === "thread.started") sessionId = ev.thread_id;
          else if (item.type === "agent_message" && item.text) {
            lastText = item.text;
            req.onEvent({ kind: "text", text: String(item.text).slice(0, 2000) });
          } else if (item.type === "command_execution" && ev.type === "item.started") req.onEvent({ kind: "tool", tool: "shell", input: { command: item.command } });
          else if (item.type === "file_change" && ev.type === "item.completed") req.onEvent({ kind: "tool", tool: "edit", input: { file_path: (item.changes ?? []).map((c: { path: string }) => c.path).join(", ") } });
          else if (ev.type === "turn.completed" && ev.usage) req.onEvent({ kind: "result", text: `tokens in ${ev.usage.input_tokens ?? "?"} out ${ev.usage.output_tokens ?? "?"}` });
          else if (ev.type === "turn.failed" || ev.type === "error" || item.type === "error") {
            const msg = String(ev.error?.message ?? ev.message ?? item.message ?? "error");
            failure = msg;
            if (LIMIT_RE.test(msg)) {
              limited = true;
              resumeAt = parseResetTime(msg);
              req.onEvent({ kind: "usage", usage: { status: "limited", resetsAt: resumeAt } });
            }
            req.onEvent({ kind: "error", text: msg.slice(0, 500) });
          } else req.onEvent({ kind: "text", text: "" }); // any event counts as activity for the watchdog
        }
      });
      let stderr = "";
      child.stderr.on("data", (d) => {
        stderr += d;
        if (stderr.length > 20_000) stderr = stderr.slice(-10_000);
      });
      child.on("error", (e) => {
        failure = `could not start codex (${this.cmd[0]}): ${e.message}. Install it with: npm install -g @openai/codex`;
      });
      child.on("close", (c) => {
        clearTimeout(timer);
        clearInterval(poll);
        req.signal?.removeEventListener("abort", kill);
        if (!failure && c !== 0) failure = stderr.trim().slice(-800) || `codex exited ${c}`;
        if (LIMIT_RE.test(stderr)) {
          limited = true;
          resumeAt = resumeAt ?? parseResetTime(stderr);
        }
        resolve(c ?? 1);
      });
    });
    await pump().catch(() => {}); // last mailbox entries written just before exit
    if (existsSync(lastFile)) lastText = readFileSync(lastFile, "utf8").trim() || lastText;

    if (limited) return { ok: false, reason: "usage_limit", resumeAt, text: failure, costUsd: 0, sessionId, denials: 0 };
    const ok = code === 0 && !failure;
    return { ok, reason: ok ? undefined : "error", text: ok ? lastText : failure, costUsd: 0, sessionId, denials: 0 };
  }
}
