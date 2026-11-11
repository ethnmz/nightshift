#!/usr/bin/env node
// Stand-in for the `codex` CLI in tests: same flags, same JSONL event stream.
// Behavior comes from FAKE_CODEX (JSON): { writes, outbox:[...], limit, wait_inbox_ms, verdict }
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const val = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
if (args[0] === "exec" && args.includes("--help")) {
  console.log("Usage: codex exec [OPTIONS]\n  -s, --sandbox <SANDBOX_MODE> [possible values: read-only, workspace-write, danger-full-access]\n  --json");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  console.log(process.env.FAKE_CODEX_LOGIN ?? "Logged in using ChatGPT");
  process.exit(0);
}
const cfg = JSON.parse(process.env.FAKE_CODEX ?? "{}");
const cwd = val("-C");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const checks = {
  approval: args.join(" ").includes('approval_policy="never"'),
  sandbox: val("-s"),
  apiKeys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"].filter((k) => process.env[k]),
  pushurl: process.env.GIT_CONFIG_VALUE_0 ?? null,
};
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", async () => {
  out({ type: "thread.started", thread_id: "fake-thread-1" });
  out({ type: "turn.started" });
  if (cfg.limit) {
    out({ type: "error", message: "You've hit your usage limit. Try again in 2 minutes." });
    process.exit(1);
  }
  const readOnly = checks.sandbox === "read-only";
  if (!readOnly) {
    for (const [p, c] of Object.entries(cfg.writes ?? {})) {
      mkdirSync(dirname(join(cwd, p)), { recursive: true });
      writeFileSync(join(cwd, p), c);
      out({ type: "item.completed", item: { type: "file_change", changes: [{ path: p, kind: "add" }] } });
    }
    for (const o of cfg.outbox ?? []) appendFileSync(join(cwd, ".nightshift-mail/outbox.jsonl"), JSON.stringify(o) + "\n");
    if (cfg.wait_inbox_ms) {
      const until = Date.now() + cfg.wait_inbox_ms;
      const inbox = join(cwd, ".nightshift-mail/inbox.md");
      while (Date.now() < until && !readFileSync(inbox, "utf8").includes("→")) await new Promise((r) => setTimeout(r, 100));
      writeFileSync(join(cwd, cfg.inbox_copy ?? "inbox-copy.txt"), readFileSync(inbox, "utf8"));
    }
    writeFileSync(join(cwd, ".nightshift-mail/flags.json"), JSON.stringify(checks));
    if (cfg.flags_file) writeFileSync(join(cwd, cfg.flags_file), JSON.stringify(checks));
  }
  const msg = readOnly ? (prompt.includes("VERDICT") ? `Looks fine.\nVERDICT: ${cfg.verdict ?? "approve"}` : "Fake answer.") : "Done.";
  out({ type: "item.completed", item: { type: "agent_message", text: msg } });
  out({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } });
  const o = val("-o");
  if (o && existsSync(dirname(o))) writeFileSync(o, msg);
  process.exit(0);
});
