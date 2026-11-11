// The overnight permission policy. Pure and synchronous: every tool call gets an
// immediate allow or deny. There is no "ask" outcome — nobody is awake to answer.
import { isAbsolute, relative, resolve, dirname, basename, join } from "node:path";
import { realpathSync, existsSync } from "node:fs";
import { homedir } from "node:os";

export type Decision = { allow: true } | { allow: false; message: string };

export interface PolicyCtx {
  cwd: string; // the task worktree; the only place writes may land
  readOnly: boolean;
  allowCommands: string[];
}

/** Tools that can only reach a human, or move the agent out of its sandbox. Also passed as disallowedTools. */
export const NEVER_TOOLS = [
  "AskUserQuestion",
  "ExitPlanMode",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitWorktree",
  "PushNotification",
  "RemoteTrigger",
  "CronCreate",
  "CronDelete",
  "ScheduleWakeup",
  "SendUserFile",
];

const READ_TOOLS = new Set([
  "Read", "Glob", "Grep", "LS", "NotebookRead", "TodoWrite", "TodoRead", "Task", "Agent",
  "BashOutput", "KillShell", "KillBash", "ToolSearch", "WebSearch", "WebFetch", "ListMcpResources", "ReadMcpResource",
]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

const SECRET_PATH = /(^|[\s/'"=:])(\.env(?!\.example|\.sample|\.template)(\.[\w-]+)?|\.ssh|\.aws|\.netrc|\.npmrc|\.pypirc|id_rsa|id_ed25519|\.gnupg|Keychains)(?=$|[\s/'"])/;

// Dangerous anywhere in a command line, whatever wraps it.
const DENY_PATTERNS: [RegExp, string][] = [
  [/\bgit\s+push\b/, "agents never push; Nightshift merges for you"],
  [/\bgit\s+(remote|worktree|filter-branch|replace|gc|prune|update-ref)\b/, "git plumbing that changes shared state is reserved for Nightshift"],
  [/\bgit\s+config\s+(--global|--system)/, "global git config is off-limits"],
  [/\bgit\s+(checkout|switch)\s+(-[bBc]\s+)?(main|master|night\/)/, "stay on your task branch"],
  [/\bgit\s+branch\s+-[dD]\b/, "deleting branches is reserved for Nightshift"],
  [/--force\b|(^|\s)-f\s+push|--no-verify\s+push/, "force operations are not allowed"],
  [/(^|[;&|\s(])(sudo|su|doas)\s/, "no privilege escalation"],
  [/(^|[;&|\s(])(gh|hub|glab)\s/, "GitHub CLI is reserved for Nightshift; use the nightshift tools to talk to the team"],
  [/(curl|wget)[^|]*\|\s*(ba|z)?sh\b/, "piping downloads into a shell is not allowed"],
  [/(^|[;&|\s(])(ssh|scp|sftp|rsync|nc|ncat|telnet)\s/, "no remote shells"],
  [/(^|[;&|\s(])(osascript|launchctl|pmset|caffeinate|shutdown|reboot|security|defaults|open)\s/, "no OS-level control"],
  [/(^|[;&|\s(])(kill|pkill|killall)\s/, "do not kill processes; long commands are timed out for you"],
  [/\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+(\/|~|\$HOME|\.\.)(\s|$|\/)/, "recursive delete outside the worktree"],
  [/(npm|pnpm|yarn)\s+(publish|login|adduser|token)\b/, "publishing and registry auth are not allowed"],
  [/(^|\s)(~\/|\$HOME\/)/, "stay inside the task worktree"],
];

const READ_ONLY_DENY = /\bgit\s+(commit|add|reset|rebase|checkout|switch|merge|stash|rm|mv|restore|clean|apply|am|cherry-pick|revert|tag)\b|(^|[;&|\s(])(rm|mv|cp|touch|mkdir|chmod|chown|ln|tee|truncate|dd)\s|\bsed\s+-i|(^|[^0-9&>])>{1,2}(?!&|\s*\/dev\/null)/;

const deny = (why: string): Decision => ({
  allow: false,
  message:
    `Denied by Nightshift policy: ${why}. No human is available to approve this, so do not retry it. ` +
    `Take another route that stays inside your task, or call record_assumption / report_blocker and continue.`,
});

/** Resolve symlinks on the longest existing prefix (macOS: /var → /private/var, /tmp → /private/tmp). */
export function canonical(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  while (!existsSync(head) && dirname(head) !== head) {
    tail.unshift(basename(head));
    head = dirname(head);
  }
  try {
    head = realpathSync(head);
  } catch {
    /* keep as is */
  }
  return tail.length ? join(head, ...tail) : head;
}

function relInside(cwd: string, p: string): string | null {
  const root = canonical(cwd);
  const abs = canonical(isAbsolute(p) ? p : resolve(cwd, p));
  const rel = relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? rel : null;
}

/** Remove heredoc bodies and quoted text: data, not commands. Command substitution ($( ) or backticks)
 *  inside double quotes is kept, because the shell runs it. Scans left to right so quote pairs never mismatch. */
export function stripData(line: string): string {
  line = line.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, "<<HEREDOC");
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\") {
      out += line.slice(i, i + 2);
      i++;
    } else if (ch === "'") {
      const j = line.indexOf("'", i + 1);
      if (j < 0) break;
      out += "''";
      i = j;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== '"') j += line[j] === "\\" ? 2 : 1;
      const inner = line.slice(i + 1, j);
      out += /\$\(|`/.test(inner) ? ` ${inner} ` : '""';
      i = j;
    } else out += ch;
  }
  return out;
}

/** Split a shell line into simple commands (good enough for allowlisting; patterns above catch wrappers). */
export function commandWords(line: string): string[] {
  const words: string[] = [];
  line = stripData(line);
  for (let seg of line.split(/&&|\|\||[;|\n`]|\$\(|[(){}]/)) {
    seg = seg.trim();
    if (!seg) continue;
    const toks = seg.split(/\s+/);
    let i = 0;
    while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++; // FOO=bar cmd
    while (i < toks.length && ["time", "nice", "command", "builtin", "exec", "nohup", "timeout"].includes(toks[i])) {
      i++;
      if (toks[i - 1] === "timeout" && /^\d/.test(toks[i] ?? "")) i++;
    }
    const w = toks[i];
    if (!w || w === "then" || w === "do" || w === "else" || w === "fi" || w === "done" || w === "!" ) continue;
    if (/^(if|for|while|until|case|esac|in)$/.test(w)) continue;
    words.push(w.replace(/^["']|["']$/g, ""));
  }
  return words;
}

export function decide(tool: string, input: Record<string, unknown>, ctx: PolicyCtx): Decision {
  if (NEVER_TOOLS.includes(tool)) return deny(`${tool} needs a human`);
  if (tool.startsWith("mcp__nightshift__")) return { allow: true };
  if (tool.startsWith("mcp__")) return deny("only the nightshift MCP tools are available overnight");

  if (READ_TOOLS.has(tool)) {
    const p = String(input.file_path ?? input.path ?? input.notebook_path ?? "").replace(/\\/g, "/");
    if (p && SECRET_PATH.test(" " + p)) return deny("secrets and credential files are never read");
    return { allow: true };
  }

  if (WRITE_TOOLS.has(tool)) {
    if (ctx.readOnly) return deny("this role is read-only");
    const p = String(input.file_path ?? input.notebook_path ?? "");
    if (!p) return deny("no file path given");
    const rel = relInside(ctx.cwd, p);
    if (rel === null) return deny(`writes must stay inside the task worktree (${ctx.cwd})`);
    if (/^(\.git|\.nightshift)([\/\\]|$)/.test(rel)) return deny("git internals and .nightshift/ are managed by Nightshift");
    if (SECRET_PATH.test(" " + rel.replace(/\\/g, "/"))) return deny("secrets files are never written");
    return { allow: true };
  }

  if (tool === "Bash") {
    const cmd = String(input.command ?? "");
    if (!cmd.trim()) return deny("empty command");
    if (SECRET_PATH.test(" " + cmd)) return deny("secrets and credential files are never touched");
    for (const [re, why] of DENY_PATTERNS) if (re.test(cmd)) return deny(why);
    const home = homedir().replace(/\\/g, "/");
    if (cmd.replace(/\\/g, "/").includes(home + "/") && !cmd.replace(/\\/g, "/").includes(ctx.cwd.replace(/\\/g, "/"))) return deny("stay inside the task worktree");
    if (ctx.readOnly && READ_ONLY_DENY.test(stripData(cmd))) return deny("this role is read-only");
    const allowed = new Set(ctx.allowCommands);
    for (const w of commandWords(cmd)) {
      const base = w.split("/").pop()!;
      if (w.startsWith("./") || w.startsWith("node_modules/.bin/") || w.startsWith(".venv/bin/")) continue; // project-local scripts
      if (!allowed.has(base)) return deny(`"${base}" is not on this night's command allowlist (allow_commands in night.yaml)`);
    }
    return { allow: true };
  }

  return deny(`tool ${tool} is not enabled overnight`);
}

/** Wraps any decision source so it ALWAYS resolves (a hanging permission callback would block forever). */
export async function neverHang(fn: () => Decision | Promise<Decision>, ms = 5000): Promise<Decision> {
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise<Decision>((r) => setTimeout(() => r(deny("permission check timed out")), ms)),
    ]);
  } catch (e) {
    return deny(`permission check failed: ${String(e).slice(0, 200)}`);
  }
}
