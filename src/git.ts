import { run, RunResult } from "./exec.js";

export class GitError extends Error {
  constructor(public args: string[], public result: RunResult) {
    super(`git ${args.join(" ")} failed (${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 800)}`);
  }
}

export class Git {
  constructor(public cwd: string, private identity?: { name: string; email: string }) {}

  private env(): Record<string, string> {
    if (!this.identity) return {};
    const { name, email } = this.identity;
    return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
  }

  raw(args: string[], input?: string, timeoutMs = 300_000): Promise<RunResult> {
    return run("git", args, { cwd: this.cwd, env: this.env(), input, timeoutMs });
  }

  async ok(args: string[], input?: string): Promise<string> {
    const r = await this.raw(args, input);
    if (r.code !== 0) throw new GitError(args, r);
    return r.stdout.trim();
  }

  async revParse(ref: string): Promise<string | null> {
    const r = await this.raw(["rev-parse", "--verify", "--quiet", ref + "^{commit}"]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async emptyTree(): Promise<string> {
    return this.ok(["mktree"], "");
  }

  /** Files changed between base and head (both commits). */
  async changedFiles(base: string, head = "HEAD"): Promise<string[]> {
    const out = await this.ok(["diff", "--name-only", "--no-renames", `${base}...${head}`]);
    return out ? out.split("\n").filter(Boolean) : [];
  }

  /** Stage and commit everything in the worktree. Returns false when there was nothing to commit. */
  async commitAll(message: string): Promise<boolean> {
    await this.ok(["add", "-A"]);
    const st = await this.ok(["status", "--porcelain"]);
    if (!st) return false;
    await this.ok(["commit", "-q", "--no-verify", "-m", message]);
    return true;
  }

  async isClean(): Promise<boolean> {
    return (await this.ok(["status", "--porcelain"])) === "";
  }
}
