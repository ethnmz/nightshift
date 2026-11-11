// Every subprocess Nightshift starts goes through here. Nothing may wait for a person:
// stdin is closed, every tool that knows how to prompt is told not to, and a hard
// timeout kills the whole process group.
import { spawn } from "node:child_process";

export const NONINTERACTIVE_ENV: Record<string, string> = {
  CI: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/usr/bin/false",
  SSH_ASKPASS: "/usr/bin/false",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
  GCM_INTERACTIVE: "never",
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GIT_EDITOR: "true",
  EDITOR: "true",
  VISUAL: "true",
  GIT_PAGER: "cat",
  PAGER: "cat",
  GIT_MERGE_AUTOEDIT: "no",
  npm_config_yes: "true",
  npm_config_fund: "false",
  npm_config_audit: "false",
  PIP_NO_INPUT: "1",
  PIP_DISABLE_PIP_VERSION_CHECK: "1",
  DEBIAN_FRONTEND: "noninteractive",
  HOMEBREW_NO_AUTO_UPDATE: "1",
  PYTHONUNBUFFERED: "1",
  NO_COLOR: "1",
};

export function childEnv(extra: Record<string, string> = {}, remove: string[] = []): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !remove.includes(k)) base[k] = v;
  return { ...base, ...NONINTERACTIVE_ENV, ...extra };
}

/**
 * Extra guard rails for agent processes (both Claude Code and Codex): git cannot push even if the
 * agent tries (push URL points nowhere), and `gh` sees an empty config dir, so no stored GitHub token.
 * Nightshift's own git/gh calls do not use this env.
 */
export function agentGuardEnv(emptyGhDir: string, remote = "origin"): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `remote.${remote}.pushurl`,
    GIT_CONFIG_VALUE_0: "file:///nightshift/agents-cannot-push",
    GIT_CONFIG_KEY_1: "push.default",
    GIT_CONFIG_VALUE_1: "nothing",
    GH_CONFIG_DIR: emptyGhDir,
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
  };
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  input?: string; // when set, written to stdin then closed; otherwise stdin is /dev/null
  maxOutput?: number;
}

/** Run argv without a shell. Never throws for a non-zero exit. */
export function run(cmd: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const max = opts.maxOutput ?? 2_000_000;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: childEnv(opts.env),
        stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        detached: true, // own process group, so a timeout kills grandchildren too
      });
    } catch (e) {
      resolve({ code: 127, stdout: "", stderr: String(e), timedOut: false });
      return;
    }
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killGroup();
        }, opts.timeoutMs)
      : undefined;
    child.stdout!.on("data", (d) => {
      if (stdout.length < max) stdout += d;
    });
    child.stderr!.on("data", (d) => {
      if (stderr.length < max) stderr += d;
    });
    if (opts.input !== undefined) {
      child.stdin!.on("error", () => {});
      child.stdin!.end(opts.input);
    }
    child.on("error", (e) => {
      stderr += String(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code ?? 1), stdout, stderr, timedOut });
    });
  });
}

/** Run a shell command line (acceptance checks, gate, global check). */
export function sh(line: string, opts: RunOpts = {}): Promise<RunResult> {
  return run("/bin/bash", ["-c", line], opts);
}

export function tail(s: string, n = 4000): string {
  return s.length > n ? "…" + s.slice(-n) : s;
}
