// Everything that differs between macOS, Windows and Linux lives here.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export const IS_WIN = process.platform === "win32";
export const IS_MAC = process.platform === "darwin";
export const OS_NAME = IS_WIN ? "windows" : IS_MAC ? "mac" : "linux";

/** Kill a process and everything it started. */
export function killTree(pid: number | undefined) {
  if (!pid) return;
  try {
    if (IS_WIN) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else process.kill(-pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

let bashCache: string | null | undefined;
/**
 * The shell for acceptance checks and gates. On Windows this is Git Bash (installed with
 * Git for Windows, which Nightshift needs anyway), so the same `npm test && ...` lines work
 * on every teammate's computer.
 */
export function bashPath(): string | null {
  if (bashCache !== undefined) return bashCache;
  if (process.env.NIGHTSHIFT_BASH) return (bashCache = process.env.NIGHTSHIFT_BASH);
  if (!IS_WIN) return (bashCache = existsSync("/bin/bash") ? "/bin/bash" : "bash");
  const candidates: string[] = [];
  const exec = spawnSync("git", ["--exec-path"], { encoding: "utf8", windowsHide: true });
  if (exec.status === 0) {
    // e.g. C:/Program Files/Git/mingw64/libexec/git-core → C:/Program Files/Git/bin/bash.exe
    const gitRoot = resolve(exec.stdout.trim(), "..", "..", "..");
    candidates.push(join(gitRoot, "bin", "bash.exe"), join(gitRoot, "usr", "bin", "bash.exe"));
  }
  for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], join(process.env.LOCALAPPDATA ?? "", "Programs")]) {
    if (base) candidates.push(join(base, "Git", "bin", "bash.exe"));
  }
  return (bashCache = candidates.find((c) => existsSync(c)) ?? null);
}

/** argv for running a shell line. */
export function shellArgv(line: string): [string, string[]] {
  const bash = bashPath();
  if (bash) return [bash, ["-c", line]];
  return ["cmd.exe", ["/d", "/s", "/c", line]]; // last resort on a Windows machine without Git Bash
}

/**
 * How to start an npm-installed CLI without a shell. On Windows, npm installs `codex.cmd`
 * shims that Node cannot spawn directly, so we run the package's JS entry with node.
 */
export function resolveCli(name: "codex" | "claude", override?: string): [string, string[]] {
  const o = override ?? (name === "codex" ? process.env.NIGHTSHIFT_CODEX_BIN : process.env.NIGHTSHIFT_CLAUDE_BIN);
  if (o) return /\.(c|m)?js$/.test(o) ? [process.execPath, [o]] : [o, []];
  if (!IS_WIN) return [name, []];
  if (name === "claude") {
    const native = join(homedir(), ".local", "bin", "claude.exe");
    if (existsSync(native)) return [native, []];
  }
  const root = spawnSync("npm", ["root", "-g"], { encoding: "utf8", shell: true, windowsHide: true }).stdout?.trim();
  const entry = root
    ? name === "codex"
      ? join(root, "@openai", "codex", "bin", "codex.js")
      : join(root, "@anthropic-ai", "claude-code", "cli.js")
    : "";
  if (entry && existsSync(entry)) return [process.execPath, [entry]];
  return [`${name}.exe`, []];
}

/** Keep the computer awake for as long as `pid` lives. Returns a short description. */
export function keepAwake(pid: number): string {
  try {
    if (IS_MAC) {
      spawn("caffeinate", ["-dimsu", "-w", String(pid)], { detached: true, stdio: "ignore" }).unref();
      return "caffeinate";
    }
    if (IS_WIN) {
      // ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED, held until the node exits.
      const ps = `$s=Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);' -Name P -Namespace W -PassThru; $s::SetThreadExecutionState(0x80000041) | Out-Null; try { Wait-Process -Id ${pid} } catch {}`;
      spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      return "Windows power request";
    }
    spawn("systemd-inhibit", ["--what=idle:sleep", "--why=nightshift", "tail", `--pid=${pid}`, "-f", "/dev/null"], { detached: true, stdio: "ignore" }).unref();
    return "systemd-inhibit";
  } catch {
    return "none";
  }
}

export type Power = "ac" | "battery" | "unknown";
export function powerSource(): Power {
  try {
    if (IS_MAC) {
      const r = spawnSync("pmset", ["-g", "batt"], { encoding: "utf8" });
      return r.stdout.includes("AC Power") ? "ac" : r.stdout.includes("Battery Power") ? "battery" : "unknown";
    }
    if (IS_WIN) {
      const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_Battery | Select-Object -First 1).BatteryStatus"], { encoding: "utf8", windowsHide: true });
      const v = r.stdout.trim();
      if (!v) return "ac"; // no battery: a desktop
      return v === "2" ? "ac" : "battery";
    }
    const r = spawnSync("cat", ["/sys/class/power_supply/AC/online"], { encoding: "utf8" });
    return r.stdout.trim() === "1" ? "ac" : r.stdout.trim() === "0" ? "battery" : "unknown";
  } catch {
    return "unknown";
  }
}

export function openBrowser(url: string) {
  try {
    if (IS_MAC) spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    else if (IS_WIN) spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* the URL is printed too */
  }
}

/** Per-user Nightshift settings (recent projects, which teammate this computer is). */
export const USER_DIR = join(homedir(), ".nightshift");

export function which(cmd: string): boolean {
  const r = spawnSync(IS_WIN ? "where" : "which", [cmd], { stdio: "ignore", windowsHide: true, shell: IS_WIN });
  return r.status === 0;
}

export { dirname };
