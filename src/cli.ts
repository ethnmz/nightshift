// nightshift <command> — see `nightshift help`.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { loadNight, loadTasks, paths, missingAuthorizations, nightName, nightBranch } from "./config.js";
import { NightDaemon } from "./daemon.js";
import { preflight, preflightOk } from "./preflight.js";
import { buildReport, openMorningPr } from "./report.js";
import { plan } from "./planner.js";
import { serve } from "./server.js";
import { readiness } from "./scheduler.js";
import { keepAwake, openBrowser } from "./platform.js";
import { run } from "./exec.js";
import { makeBoard } from "./daemon.js";
import { humanLine } from "./board/envelope.js";
import { resolve as resolvePath } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = join(HERE, "..", "templates");

function args(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--") && ["node", "port", "project", "night", "agent", "dir"].includes(k)) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}

function tryRoot(): string | null {
  try {
    return root();
  } catch {
    return null;
  }
}

function root(): string {
  let d = process.cwd();
  while (d !== "/") {
    if (existsSync(join(d, ".git"))) return d;
    d = dirname(d);
  }
  throw new Error("run nightshift inside a git checkout of your project");
}

function nodeId(flags: Record<string, string | boolean>, r: string): string {
  const fromFlag = typeof flags.node === "string" ? flags.node : undefined;
  const fromEnv = process.env.NIGHTSHIFT_NODE;
  const file = join(paths(r).local, "node");
  const fromFile = existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
  const id = fromFlag ?? fromEnv ?? fromFile;
  if (!id) throw new Error("which teammate is this Mac? Pass --node <id> once (it is remembered), or set NIGHTSHIFT_NODE");
  mkdirSync(paths(r).local, { recursive: true });
  writeFileSync(file, id);
  return id;
}

const icon = { pass: "✔", warn: "!", fail: "✖" } as const;

async function main() {
  const [cmd = "help", ...rest] = process.argv.slice(2);
  const { flags } = args(rest);

  if (cmd === "help" || cmd === "--help") {
    console.log(`nightshift — overnight multi-agent builds for hackathon teams

Easiest: run \`nightshift\` (or \`npm start\` in the nightshift folder) and use the app in your browser.

Evening (everyone awake)
  init [--project NAME]        create .nightshift/{idea.md,night.yaml,tasks.yaml} from templates
  plan [--agent codex]         planner agent: idea.md → contracts, stubs, tasks.yaml
  validate                     check night.yaml + tasks.yaml, print the DAG
  serve --node ID              open the dashboard (plan editor, preflight, start) on localhost
  join <repo> --node ID [--dir PARENT]
                               teammates: clone (or update) the team's project and say which teammate
                               this computer is. Prints the project folder.
  preflight --node ID [--skip-live]   everything that could block at 3 a.m. fails now

Night (everyone asleep)
  start --node ID [--wait-for-go] [--no-dashboard] [--no-keep-awake] [--skip-preflight]
                               --wait-for-go: check now, then wait until the lead starts the night
                               run this computer's node until the night is finished
                               (keeps the computer awake; restarts the node if it crashes)
  launchd --node ID [--install]  macOS only: also restart after a reboot/logout

Any time
  status --node ID             team-wide task status from git refs
  stop [--team] --node ID      stop this node (or post a stop for every node)
  report --node ID [--pr]      morning report; --pr opens the one night→main PR
`);
    return;
  }

  if (cmd === "ui" || cmd === "app") {
    const { port } = serve({ root: tryRoot(), port: typeof flags.port === "string" ? Number(flags.port) : undefined });
    const url = `http://localhost:${port}`;
    console.log(`Nightshift is open at ${url}  (leave this window open; Ctrl+C to quit)`);
    if (!flags["no-open"]) setTimeout(() => openBrowser(url), 400);
    return;
  }

  if (cmd === "join") {
    const repoArg = rest.find((a) => !a.startsWith("--") && a !== flags.node && a !== flags.dir);
    const m = repoArg && (/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(repoArg) ?? /^([\w.-]+\/[\w.-]+)$/.exec(repoArg));
    if (!m) throw new Error("usage: nightshift join https://github.com/OWNER/REPO --node YOUR_ID");
    if (typeof flags.node !== "string") throw new Error("pass --node with your teammate id (it is in your setup prompt)");
    const slug = m[1];
    const parent = resolvePath(typeof flags.dir === "string" ? flags.dir : join(homedir(), "hackathons"));
    mkdirSync(parent, { recursive: true });
    const dir = join(parent, slug.split("/")[1]);
    if (existsSync(join(dir, ".git"))) {
      const pull = await run("git", ["pull", "-q", "--ff-only"], { cwd: dir, timeoutMs: 120_000 });
      if (pull.code !== 0) throw new Error(`could not update ${dir}: ${pull.stderr.trim()}`);
      console.log(`Updated ${dir}`);
    } else {
      const c = await run("gh", ["repo", "clone", slug, dir], { timeoutMs: 300_000 });
      if (c.code !== 0) throw new Error(`could not clone ${slug}: ${(c.stderr || c.stdout).trim()}. Did you accept the GitHub invitation?`);
      console.log(`Cloned ${slug} into ${dir}`);
    }
    const cfg = loadNight(dir);
    const me = cfg.nodes.find((n) => n.id === flags.node);
    if (!me) throw new Error(`"${flags.node}" is not on this team. Teammate ids: ${cfg.nodes.map((n) => n.id).join(", ")}`);
    mkdirSync(paths(dir).local, { recursive: true });
    writeFileSync(join(paths(dir).local, "node"), me.id);
    console.log(`This computer is ${me.name} (${me.id}), roles: ${me.lanes.join(", ")}.`);
    console.log(`PROJECT_DIR=${dir}`);
    return;
  }

  const r = root();
  const p = paths(r);

  if (cmd === "init") {
    mkdirSync(p.dir, { recursive: true });
    for (const [src, dst] of [["night.yaml", p.night], ["tasks.yaml", p.tasks], ["idea.md", p.idea]] as const) {
      if (existsSync(dst)) console.log(`exists  ${dst}`);
      else {
        let text = readFileSync(join(TEMPLATES, src), "utf8");
        if (typeof flags.project === "string") text = text.replace(/^project: .*$/m, `project: ${flags.project}`);
        writeFileSync(dst, text);
        console.log(`created ${dst}`);
      }
    }
    const gi = join(r, ".gitignore");
    const line = ".nightshift/local/";
    if (!existsSync(gi) || !readFileSync(gi, "utf8").includes(line)) appendFileSync(gi, `\n${line}\n`);
    console.log(`\nNext: write ${p.idea}, edit nodes in night.yaml, then \`nightshift plan\` (or write tasks.yaml), commit and push .nightshift/.`);
    return;
  }

  if (cmd === "validate") {
    const cfg = loadNight(r);
    const tasks = loadTasks(r);
    const miss = missingAuthorizations(cfg);
    console.log(`night ${nightName(cfg)} → ${nightBranch(nightName(cfg))} · ${cfg.nodes.length} nodes · ${tasks.length} tasks`);
    for (const n of cfg.nodes) console.log(`  ${n.name} (${n.id}): ${n.lanes.join(", ")} — ${tasks.filter((t) => n.lanes.includes(t.lane)).length} tasks`);
    for (const t of tasks) console.log(`  ${t.id.padEnd(10)} [${t.lane}] ${t.title}${t.depends_on.length ? `  ← ${t.depends_on.join(", ")}` : ""}`);
    if (miss.length) console.log(`\n✖ not authorized yet: ${miss.join(", ")}`);
    return;
  }

  if (cmd === "plan") {
    const res = await plan(r, console.log, flags.agent === "codex" ? "codex" : "claude");
    console.log(res.ok ? `\nPlanned ${res.tasks} tasks ($${res.cost.toFixed(2)}). Review .nightshift/tasks.yaml and the contracts, then commit and push.` : `\nPlanner did not produce a valid tasks.yaml: ${res.errors}`);
    process.exitCode = res.ok ? 0 : 1;
    return;
  }

  const id = nodeId(flags, r);

  if (cmd === "preflight") {
    const res = await preflight(r, id, { live: !flags["skip-live"] });
    for (const c of res) console.log(`${icon[c.status]} ${c.name.padEnd(30)} ${c.detail}`);
    const ok = preflightOk(res);
    console.log(ok ? "\nReady for the night." : "\nFix the ✖ items before you sleep.");
    if (ok) await postToBoard(r, id, "ready", "is ready for tonight (checks passed).").then((posted) => posted && console.log("Told the team board this computer is ready."));
    process.exitCode = ok ? 0 : 1;
    return;
  }

  if (cmd === "serve") {
    const { port } = serve({ root: r, node: id, port: typeof flags.port === "string" ? Number(flags.port) : undefined });
    console.log(`Nightshift: http://localhost:${port}`);
    return;
  }

  if (cmd === "start" && !flags.child) {
    // Supervisor: preflight, keep the computer awake, then run the node in a child process and
    // restart it if it crashes. A clean finish or a stop request ends the loop.
    if (!flags["skip-preflight"]) {
      const res = await preflight(r, id, { live: !flags["skip-live"] });
      const bad = res.filter((c) => c.status === "fail");
      if (bad.length) {
        for (const c of bad) console.error(`✖ ${c.name}: ${c.detail}`);
        console.error("Preflight failed; not starting. (Fix it now; nobody can fix it at 3 a.m.)");
        process.exitCode = 1;
        return;
      }
    }
    const cfg = loadNight(r);
    const miss = missingAuthorizations(cfg);
    if (miss.length) throw new Error(`not authorized in night.yaml: ${miss.join(", ")}`);
    if (flags["wait-for-go"]) {
      // Ready now; begin when the lead starts the night (a "go" post, or any teammate's node coming up).
      await postToBoard(r, id, "ready", "is ready and waiting for the lead to start the night.");
      const night = nightName(cfg);
      const board = makeBoard(cfg, r, join(p.local, id, "wait-cursor"));
      console.log("Ready. Waiting for the team lead to start the night. Leave this window open, plugged in, lid open.");
      if (!flags["no-keep-awake"]) keepAwake(process.pid);
      for (;;) {
        const msgs = await board.fetchAll().catch(() => []);
        const go = msgs.find((m) => m.env && m.env.night === night && m.env.from !== id && (m.env.type === "go" || m.env.type === "node_up"));
        if (go) {
          console.log(`The night has started (${go.env!.type === "go" ? "the lead said go" : `${go.env!.from}'s computer started`}). Starting this computer.`);
          break;
        }
        if (existsSync(join(p.local, id, "STOP"))) return;
        await new Promise((res) => setTimeout(res, Number(process.env.NIGHTSHIFT_GO_POLL_MS ?? 20_000)));
      }
    }
    if (flags.go) await postToBoard(r, id, "go", "started the night for everyone.");
    const dir = join(p.local, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "daemon.pid"), String(process.pid));
    if (existsSync(join(dir, "STOP"))) rmSync(join(dir, "STOP")); // a stop from an earlier night
    if (!flags["no-keep-awake"] && !flags["no-caffeinate"]) console.log(`Keeping this computer awake (${keepAwake(process.pid)}).`);
    const loader = import.meta.resolve("tsx");
    const childArgs = ["--import", loader, join(HERE, "cli.ts"), "start", "--child", "--node", id, ...(flags["no-dashboard"] ? ["--no-dashboard"] : [])];
    let stopping = false;
    let child: ReturnType<typeof spawn> | null = null;
    const stop = () => {
      stopping = true;
      writeFileSync(join(dir, "STOP"), new Date().toISOString());
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    for (let restarts = 0; ; restarts++) {
      child = spawn(process.execPath, childArgs, { cwd: r, stdio: "inherit", windowsHide: true });
      const code: number = await new Promise((res) => child!.on("exit", (c) => res(c ?? 1)));
      if (code === 0 || stopping || existsSync(join(dir, "STOP"))) break;
      if (restarts >= 30) {
        console.error("The node crashed too many times; giving up. Its tasks will move to teammates.");
        break;
      }
      console.error(`The node stopped unexpectedly (exit ${code}). Restarting in 15 s (restart ${restarts + 1}).`);
      await new Promise((res) => setTimeout(res, 15_000));
    }
    process.exit(0);
  }

  if (cmd === "start") {
    // The node itself (started by the supervisor above).
    const d = new NightDaemon({ root: r, node: id });
    d.ledger.on("event", (e) => {
      if (["task_claimed", "task_done", "task_parked", "task_released", "paused", "stopped", "error", "gate"].includes(e.kind)) console.log(`${new Date(e.at).toLocaleTimeString()} ${e.kind} ${e.task ?? ""} ${e.data ? JSON.stringify(e.data).slice(0, 160) : ""}`);
    });
    if (!flags["no-dashboard"]) {
      const { port } = serve({ root: r, node: id, daemon: d });
      console.log(`Nightshift: http://localhost:${port}`);
    }
    const shutdown = () => d.stop("signal");
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    console.log(`${d.me.name}'s node: night ${d.night}, branch ${d.branch}, agent ${d.adapter.name}. Good night.`);
    await d.start();
    const rep = await buildReport(r, id).catch(() => null);
    console.log(`\n${d.summary()}${rep ? `\nReport: ${rep.file}` : ""}`);
    process.exit(0);
  }

  if (cmd === "status") {
    const d = new NightDaemon({ root: r, node: id });
    await d.refreshStates();
    const rd = d.readinessNow();
    for (const t of d.tasks) {
      const s = d.states.get(t.id)?.state;
      console.log(`${(rd.get(t.id) ?? "").padEnd(8)} ${t.id.padEnd(12)} [${t.lane}] ${t.title}${s ? `  (${s.node}${s.note ? ": " + s.note.slice(0, 80) : ""})` : ""}`);
    }
    const counts = [...readiness(d.tasks, d.states, () => false).values()].reduce<Record<string, number>>((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {});
    console.log(`\n${JSON.stringify(counts)}`);
    return;
  }

  if (cmd === "stop") {
    const dir = join(p.local, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "STOP"), new Date().toISOString());
    console.log(`Stop requested for ${id}.`);
    if (flags.team) {
      const d = new NightDaemon({ root: r, node: id });
      await d.post("stop", `${d.me.name} stopped the whole team.`);
      console.log("Posted a team stop to the board.");
    }
    return;
  }

  if (cmd === "report") {
    const rep = await buildReport(r, id, typeof flags.night === "string" ? flags.night : undefined);
    console.log(rep.markdown);
    console.log(`(saved to ${rep.file})`);
    if (flags.pr) console.log(await openMorningPr(r, rep, typeof flags.night === "string" ? flags.night : undefined));
    return;
  }

  if (cmd === "launchd") {
    const label = `dev.nightshift.${id}`;
    const bin = join(HERE, "..", "bin", "nightshift.mjs");
    const log = join(p.local, id, "launchd.log");
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string><string>${bin}</string><string>start</string>
    <string>--node</string><string>${id}</string><string>--skip-preflight</string>
  </array>
  <key>WorkingDirectory</key><string>${r}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${process.env.PATH}</string></dict>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`;
    if (!flags.install) {
      console.log(plist);
      console.log(`# Restarts the node if it crashes (not after a clean finish). Install with: nightshift launchd --node ${id} --install`);
      return;
    }
    const dst = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, plist);
    console.log(`Wrote ${dst}. Load it with: launchctl load -w ${dst}   (unload in the morning: launchctl unload -w ${dst})`);
    return;
  }

  throw new Error(`unknown command ${cmd}. Try: nightshift help`);
}

main().catch((e) => {
  console.error(`nightshift: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});

/** Post one structured note to the team board from the command line. Never throws. */
async function postToBoard(root: string, id: string, type: "ready" | "go", text: string): Promise<boolean> {
  try {
    const cfg = loadNight(root);
    if (cfg.board.kind === "github" && !cfg.board.issue) return false;
    const me = cfg.nodes.find((n) => n.id === id);
    if (!me) return false;
    const board = makeBoard(cfg, root, join(paths(root).local, id, "cli-board-cursor"));
    await board.post(humanLine(me.name, text), { v: 1, from: id, to: "*", type, body: {}, at: Date.now(), night: nightName(cfg) });
    return true;
  } catch {
    return false;
  }
}
