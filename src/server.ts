// Local dashboard server (localhost only). Serves the built dashboard and a small JSON API.
// It shows team-wide state, read from git refs and the board, so every teammate's dashboard
// shows all nodes.
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import YAML from "yaml";
import { NightDaemon } from "./daemon.js";
import { NightConfig, TaskFile, validateTasks, paths } from "./config.js";
import { preflight } from "./preflight.js";
import { buildReport } from "./report.js";
import type { BoardMessage } from "./board/envelope.js";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dashboard", "dist");
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

export interface ServeOpts {
  root: string;
  node: string;
  port?: number;
  /** The live daemon when the server runs inside `nightshift start`; otherwise an observer is used. */
  daemon?: NightDaemon;
}

export function serve(o: ServeOpts) {
  const live = !!o.daemon;
  let observer: NightDaemon | undefined;
  const d = () => o.daemon ?? (observer ??= new NightDaemon({ root: o.root, node: o.node, exitWhenDone: false }));
  let boardCache: { at: number; msgs: BoardMessage[] } = { at: 0, msgs: [] };
  const boardMsgs = async () => {
    if (Date.now() - boardCache.at > 10_000) {
      try {
        boardCache = { at: Date.now(), msgs: await d().board.fetchAll() };
      } catch {
        boardCache.at = Date.now();
      }
    }
    return boardCache.msgs;
  };
  const sseClients = new Set<ServerResponse>();
  const daemonPid = () => {
    const f = join(paths(o.root).local, o.node, "daemon.pid");
    if (!existsSync(f)) return null;
    const pid = Number(readFileSync(f, "utf8"));
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      return null;
    }
  };

  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const body = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let s = "";
      req.on("data", (c) => (s += c));
      req.on("end", () => resolve(s));
    });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Only answer local requests; the dashboard can stop or start the night.
    const host = (req.headers.host ?? "").split(":")[0];
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) return json(res, 403, { error: "local only" });
    try {
      if (url.pathname === "/api/snapshot") {
        const dm = d();
        if (!live) await dm.refreshStates().catch(() => {});
        const msgs = await boardMsgs();
        if (!live) for (const m of msgs) dm.ingest(m, true);
        return json(res, 200, {
          ...dm.snapshot(),
          live,
          daemonPid: live ? process.pid : daemonPid(),
          board: msgs.filter((m) => !m.env?.night || m.env.night === dm.night).slice(-200).map((m) => ({ id: m.id, author: m.author, createdAt: m.createdAt, text: m.text.split("\n")[0], env: m.env })),
          ledger: live ? dm.ledger.tail(300) : dm.ledger.all().slice(-300),
        });
      }
      if (url.pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(": hello\n\n");
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }
      if (url.pathname === "/api/plan" && req.method === "GET") {
        const p = paths(o.root);
        return json(res, 200, {
          night: existsSync(p.night) ? readFileSync(p.night, "utf8") : "",
          tasks: existsSync(p.tasks) ? readFileSync(p.tasks, "utf8") : "",
          idea: existsSync(p.idea) ? readFileSync(p.idea, "utf8") : "",
        });
      }
      if (url.pathname === "/api/plan" && req.method === "PUT") {
        const b = JSON.parse(await body(req)) as { night?: string; tasks?: string; idea?: string };
        const p = paths(o.root);
        const errors: string[] = [];
        if (b.night !== undefined) {
          const r = NightConfig.safeParse(YAML.parse(b.night));
          if (!r.success) errors.push(`night.yaml: ${r.error.message}`);
        }
        if (b.tasks !== undefined) {
          try {
            validateTasks(TaskFile.parse(YAML.parse(b.tasks)).tasks);
          } catch (e) {
            errors.push(`tasks.yaml: ${String(e)}`);
          }
        }
        if (errors.length) return json(res, 400, { errors });
        if (live) return json(res, 409, { errors: ["the night is running; edit the plan before starting"] });
        if (b.night !== undefined) writeFileSync(p.night, b.night);
        if (b.tasks !== undefined) writeFileSync(p.tasks, b.tasks);
        if (b.idea !== undefined) writeFileSync(p.idea, b.idea);
        observer = undefined;
        return json(res, 200, { ok: true, note: "Saved locally. Commit and push .nightshift/ so every node runs the same plan." });
      }
      if (url.pathname === "/api/preflight" && req.method === "POST") {
        return json(res, 200, await preflight(o.root, o.node, { live: url.searchParams.get("live") !== "0" }));
      }
      if (url.pathname === "/api/start" && req.method === "POST") {
        if (live || daemonPid()) return json(res, 409, { error: "already running" });
        const dir = join(paths(o.root).local, o.node);
        mkdirSync(dir, { recursive: true });
        const logFd = openSync(join(dir, "daemon.log"), "a");
        const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "nightshift.mjs");
        const child = spawn(process.execPath, [bin, "start", "--node", o.node, "--no-dashboard"], { cwd: o.root, detached: true, stdio: ["ignore", logFd, logFd] });
        child.unref();
        return json(res, 200, { ok: true, pid: child.pid });
      }
      if (url.pathname === "/api/stop" && req.method === "POST") {
        const team = url.searchParams.get("team") === "1";
        const dir = join(paths(o.root).local, o.node);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "STOP"), new Date().toISOString());
        if (team) await d().post("stop", `${o.node} stopped the whole team from the dashboard.`);
        if (live) o.daemon!.stop(team ? "team stop from dashboard" : "stop from dashboard");
        return json(res, 200, { ok: true, team });
      }
      if (url.pathname === "/api/report") {
        const r = await buildReport(o.root, o.node);
        return json(res, 200, r);
      }
      // static dashboard
      let file = join(DIST, url.pathname === "/" ? "index.html" : url.pathname);
      if (!file.startsWith(DIST) || !existsSync(file)) file = join(DIST, "index.html");
      if (!existsSync(file)) {
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end("Dashboard not built. Run: npm run build:dashboard");
      }
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(readFileSync(file));
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
  });

  // Live events: the in-process ledger when running; otherwise tail the daemon's ledger file.
  const push = (e: unknown) => {
    for (const c of sseClients) c.write(`data: ${JSON.stringify(e)}\n\n`);
  };
  if (live) o.daemon!.ledger.on("event", push);
  else {
    let seen = 0;
    setInterval(() => {
      const all = d().ledger.all();
      for (const e of all.slice(seen)) push(e);
      seen = all.length;
    }, 2000).unref();
  }
  setInterval(() => push({ kind: "ping", at: Date.now() }), 15_000).unref();

  const port = o.port ?? d().cfg.dashboard_port;
  server.on("error", (e) => console.error(`dashboard not started on :${port}: ${String(e)} (the night keeps running)`));
  server.listen(port, "127.0.0.1");
  return { server, port };
}
