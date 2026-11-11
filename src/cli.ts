// nightshift <command> — see `nightshift help`.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
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
      else if (argv[i + 1] && !argv[i + 1].startsWith("--") && ["node", "port", "project", "night"].includes(k)) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { flags, pos };
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
    console.log(`nightshift — overnight multi-agent builds for 4-person teams

Evening (everyone awake)
  init [--project NAME]        create .nightshift/{idea.md,night.yaml,tasks.yaml} from templates
  plan                         planner agent: idea.md → contracts, stubs, tasks.yaml
  validate                     check night.yaml + tasks.yaml, print the DAG
  serve --node ID              open the dashboard (plan editor, preflight, start) on localhost
  preflight --node ID [--skip-live]   everything that could block at 3 a.m. fails now

Night (everyone asleep)
  start --node ID [--no-dashboard] [--no-caffeinate] [--skip-preflight]
                               run this Mac's node until the night is finished
  launchd --node ID [--install]  print (or install) a launchd agent that restarts the node if it crashes

Any time
  status --node ID             team-wide task status from git refs
  stop [--team] --node ID      stop this node (or post a stop for every node)
  report --node ID [--pr]      morning report; --pr opens the one night→main PR
`);
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
    const res = await plan(r);
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
    process.exitCode = ok ? 0 : 1;
    return;
  }

  if (cmd === "serve") {
    const { port } = serve({ root: r, node: id, port: typeof flags.port === "string" ? Number(flags.port) : undefined });
    console.log(`Dashboard: http://localhost:${port}`);
    return;
  }

  if (cmd === "start") {
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
    const dir = join(p.local, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "daemon.pid"), String(process.pid));
    if (!flags["no-caffeinate"] && process.platform === "darwin") {
      // Keep the Mac awake exactly as long as this process lives.
      spawn("caffeinate", ["-dimsu", "-w", String(process.pid)], { detached: true, stdio: "ignore" }).unref();
    }
    const d = new NightDaemon({ root: r, node: id });
    d.ledger.on("event", (e) => {
      if (["task_claimed", "task_done", "task_parked", "stopped", "error", "gate"].includes(e.kind)) console.log(`${new Date(e.at).toLocaleTimeString()} ${e.kind} ${e.task ?? ""} ${e.data ? JSON.stringify(e.data).slice(0, 160) : ""}`);
    });
    if (!flags["no-dashboard"]) {
      try {
        const { port } = serve({ root: r, node: id, daemon: d });
        console.log(`Dashboard: http://localhost:${port}`);
      } catch {
        /* port busy: the night still runs */
      }
    }
    const shutdown = () => d.stop("signal");
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    console.log(`${d.me.name}'s node: night ${d.night}, branch ${d.branch}, adapter ${d.adapter.name}. Good night.`);
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
