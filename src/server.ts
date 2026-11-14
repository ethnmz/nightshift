// Local web app server (localhost only): the onboarding wizard, the Live view and the Results
// page. It works before a project exists (welcome screen) and switches projects.
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, statSync, rmSync } from "node:fs";
import { join, dirname, extname, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import YAML from "yaml";
import { RelayDaemon, makeBoard } from "./daemon.js";
import { RelayConfig, TaskFile, validateTasks, paths, loadConfig, runName, newRunId, Task } from "./config.js";
import { preflight } from "./preflight.js";
import { buildReport, openRunPr } from "./report.js";
import { plan } from "./planner.js";
import { Setup, loadSetup, saveSetup, adoptPlannerChecks } from "./setup.js";
import { autofill } from "./autofill.js";
import { draftSubmission, commitSubmission } from "./submission.js";
import { teammatePrompt, writeTeammatePrompts } from "./onboarding.js";
import { loadTasks } from "./config.js";
import { createPractice } from "./practice.js";
import { run } from "./exec.js";
import { IS_WIN, OS_NAME, USER_DIR, bashPath, resolveCli } from "./platform.js";
import { humanLine, type BoardMessage, type Envelope } from "./board/envelope.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dashboard", "dist");
const LAUNCHER = join(HERE, "..", "bin", "relay.mjs");
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

// ---------- per-user settings (recent projects, auto-start) ----------
interface UserSettings {
  recent: string[];
  autoStart: Record<string, boolean>;
}
const SETTINGS = join(USER_DIR, "settings.json");
function loadSettings(): UserSettings {
  try {
    return { recent: [], autoStart: {}, ...JSON.parse(readFileSync(SETTINGS, "utf8")) };
  } catch {
    return { recent: [], autoStart: {} };
  }
}
function saveSettings(s: UserSettings) {
  mkdirSync(USER_DIR, { recursive: true });
  writeFileSync(SETTINGS, JSON.stringify(s, null, 2));
}

function isGitRepo(dir: string) {
  return existsSync(join(dir, ".git"));
}
function findRepo(start: string): string | null {
  let d = resolve(start);
  for (;;) {
    if (isGitRepo(d)) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

export interface ServeOpts {
  root?: string | null;
  node?: string;
  port?: number;
  /** The live daemon when the server runs inside `relay start --child`. */
  daemon?: RelayDaemon;
}

export function serve(o: ServeOpts) {
  let root: string | null = o.root ?? null;
  const live = o.daemon;
  let observer: RelayDaemon | undefined;
  let boardCache: { at: number; msgs: BoardMessage[]; key: string } = { at: 0, msgs: [], key: "" };
  const sse = new Set<ServerResponse>();
  const planJob: { running: boolean; log: string[]; ok?: boolean; error?: string } = { running: false, log: [] };

  const settings = loadSettings();
  const remember = (dir: string) => {
    settings.recent = [dir, ...settings.recent.filter((x) => x !== dir)].slice(0, 8);
    saveSettings(settings);
  };
  if (root) remember(root);

  const myNode = (): string | null => {
    if (o.node) return o.node;
    if (!root) return null;
    const f = join(paths(root).local, "node");
    return existsSync(f) ? readFileSync(f, "utf8").trim() || null : null;
  };
  const setMyNode = (id: string) => {
    mkdirSync(paths(root!).local, { recursive: true });
    writeFileSync(join(paths(root!).local, "node"), id);
    observer = undefined;
  };
  const openProject = (dir: string) => {
    root = dir;
    observer = undefined;
    boardCache = { at: 0, msgs: [], key: "" };
    remember(dir);
  };

  const hasRun = () => !!root && existsSync(paths(root).config);
  const daemonPid = (): number | null => {
    const n = myNode();
    if (!root || !n) return null;
    const f = join(paths(root).local, n, "daemon.pid");
    if (!existsSync(f)) return null;
    const pid = Number(readFileSync(f, "utf8"));
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      return null;
    }
  };
  // Which run the app shows: the one named in relay.yaml (any time of day).
  let runCache: { key: string; runId: string; at: number } | null = null;
  const currentRun = async (): Promise<string | undefined> => {
    if (live) return live.runId;
    if (!root || !hasRun()) return undefined;
    if (runCache && runCache.key === root && Date.now() - runCache.at < 60_000) return runCache.runId;
    const runId = runName(loadConfig(root));
    if (runCache?.runId !== runId) observer = undefined;
    runCache = { key: root, runId, at: Date.now() };
    return runId;
  };
  const getObserver = (): RelayDaemon | null => {
    if (live) return live;
    const n = myNode();
    if (!root || !n || !hasRun()) return null;
    try {
      observer ??= new RelayDaemon({ root, node: n, exitWhenDone: false, runId: runCache?.key === root ? runCache.runId : undefined });
      return observer;
    } catch {
      return null;
    }
  };
  const boardMsgs = async (): Promise<BoardMessage[]> => {
    const d = getObserver();
    const key = `${root}|${myNode()}`;
    if (!d) return [];
    if (boardCache.key !== key || Date.now() - boardCache.at > 8000) {
      try {
        boardCache = { at: Date.now(), msgs: await d.board.fetchAll(), key };
      } catch {
        boardCache = { ...boardCache, at: Date.now(), key };
      }
    }
    return boardCache.msgs;
  };
  const postEnv = async (type: Envelope["type"], text: string, body: Record<string, unknown> = {}) => {
    const cfg = loadConfig(root!);
    const n = myNode()!;
    const me = cfg.nodes.find((x) => x.id === n)!;
    const board = makeBoard(cfg, root!, join(paths(root!).local, n, "server-board-cursor"));
    await board.post(humanLine(me.name, text), { v: 1, from: n, to: "*", type, body, at: Date.now(), runId: (await currentRun()) ?? runName(cfg) });
    boardCache.at = 0;
  };
  /** again: restarting a run this computer already checked (skip the slow final check). */
  const startNode = (again = false): number => {
    const n = myNode()!;
    const stop = join(paths(root!).local, n, "STOP");
    if (existsSync(stop)) rmSync(stop);
    const dir = join(paths(root!).local, n);
    mkdirSync(dir, { recursive: true });
    const logFd = openSync(join(dir, "daemon.log"), "a");
    const child = spawn(process.execPath, [LAUNCHER, "start", "--node", n, "--no-dashboard", ...(again ? ["--skip-preflight"] : [])], {
      cwd: root!,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    return child.pid ?? 0;
  };

  // ---------- tools check (cached) ----------
  let toolsCache: { at: number; v: unknown } = { at: 0, v: null };
  const tools = async () => {
    if (Date.now() - toolsCache.at < 60_000 && toolsCache.v) return toolsCache.v;
    const [cb, cp] = resolveCli("claude");
    const [xb, xp] = resolveCli("codex");
    const [git, gh, ghUser, claudeV, claudeAuth, codexV, codexAuth] = await Promise.all([
      run("git", ["--version"], { timeoutMs: 10_000 }),
      run("gh", ["--version"], { timeoutMs: 10_000 }),
      run("gh", ["api", "user", "--jq", ".login"], { timeoutMs: 15_000 }),
      run(cb, [...cp, "--version"], { timeoutMs: 20_000 }),
      run(cb, [...cp, "auth", "status"], { timeoutMs: 20_000 }),
      run(xb, [...xp, "--version"], { timeoutMs: 20_000 }),
      run(xb, [...xp, "login", "status"], { timeoutMs: 20_000 }),
    ]);
    let claudeSub = false;
    let claudeLogged = false;
    try {
      const j = JSON.parse(claudeAuth.stdout);
      claudeLogged = !!j.loggedIn;
      claudeSub = j.authMethod === "claude.ai";
    } catch {
      /* not installed or old version */
    }
    const codexOut = codexAuth.stdout + codexAuth.stderr;
    const v = {
      os: OS_NAME,
      node: process.version,
      git: git.code === 0,
      bash: IS_WIN ? !!bashPath() : true,
      gh: gh.code === 0,
      ghLogin: ghUser.code === 0 ? ghUser.stdout.trim() : null,
      claude: { installed: claudeV.code === 0, loggedIn: claudeLogged, subscription: claudeSub },
      codex: { installed: codexV.code === 0, loggedIn: codexAuth.code === 0 && !/not logged in/i.test(codexOut), subscription: /chatgpt/i.test(codexOut) },
    };
    toolsCache = { at: Date.now(), v };
    return v;
  };

  const ghRepo = async (): Promise<string | null> => {
    const r = await run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd: root!, timeoutMs: 20_000 });
    return r.code === 0 ? r.stdout.trim() : null;
  };

  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<any>((resolveBody) => {
      let s = "";
      req.on("data", (c) => (s += c));
      req.on("end", () => {
        try {
          resolveBody(s ? JSON.parse(s) : {});
        } catch {
          resolveBody({});
        }
      });
    });
  const need = (cond: unknown, msg: string) => {
    if (!cond) throw Object.assign(new Error(msg), { status: 400 });
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const host = (req.headers.host ?? "").split(":")[0];
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) return json(res, 403, { error: "local only" });
    const route = `${req.method} ${url.pathname}`;
    try {
      // ---------- app & projects ----------
      if (route === "GET /api/app") {
        const cfg = hasRun() ? (() => { try { return loadConfig(root!); } catch { return null; } })() : null;
        const setup = root ? loadSetup(root) : null;
        const tasks = root && existsSync(paths(root).tasks) ? ((YAML.parse(readFileSync(paths(root).tasks, "utf8"))?.tasks ?? []) as unknown[]).length : 0;
        const head = root ? await run("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: root, timeoutMs: 5000 }) : null;
        const dirty = root ? (await run("git", ["status", "--porcelain"], { cwd: root, timeoutMs: 10_000 })).stdout.trim() : "";
        return json(res, 200, {
          project: root ? { path: root, name: basename(root), hasSetup: existsSync(join(paths(root).dir, "setup.json")), tasks, hasCommits: head?.code === 0, unshared: dirty.split("\n").filter((l) => l.includes(".relay") || l.includes("docs/")).length } : null,
          recent: settings.recent.filter((d) => existsSync(d)),
          me: myNode(),
          setup,
          board: cfg ? { kind: cfg.board.kind, issue: cfg.board.kind === "github" ? cfg.board.issue ?? null : null, repo: cfg.board.kind === "github" ? cfg.board.repo ?? null : null } : null,
          runId: cfg ? runName(cfg) : null,
          running: live ? process.pid : daemonPid(),
          live: !!live,
          autoStart: root ? !!settings.autoStart[root] : false,
          home: homedir(),
          sep: IS_WIN ? "\\" : "/",
        });
      }
      if (route === "GET /api/tools") return json(res, 200, await tools());
      if (route === "POST /api/tools/refresh") {
        toolsCache.at = 0;
        return json(res, 200, await tools());
      }
      if (route === "POST /api/project/open") {
        const b = await readBody(req);
        const dir = findRepo(String(b.path ?? ""));
        need(dir, "That folder is not a git repository.");
        openProject(dir!);
        return json(res, 200, { ok: true, path: dir });
      }
      if (route === "POST /api/project/create") {
        // New private GitHub repo + local clone with a first commit.
        const b = await readBody(req);
        const name = String(b.name ?? "").trim();
        need(/^[A-Za-z0-9._-]+$/.test(name), "Use letters, numbers, dashes, dots or underscores for the repo name.");
        const parent = resolve(String(b.parent || join(homedir(), "hackathons")));
        mkdirSync(parent, { recursive: true });
        const dir = join(parent, name);
        need(!existsSync(dir), `${dir} already exists. Pick another name or open that folder.`);
        const c = await run("gh", ["repo", "create", name, "--private", "--clone", "--add-readme", "--description", String(b.description ?? "Hackathon project")], { cwd: parent, timeoutMs: 120_000 });
        need(c.code === 0, `GitHub said: ${(c.stderr || c.stdout).trim().slice(0, 300)}`);
        await run("git", ["pull", "-q"], { cwd: dir, timeoutMs: 60_000 });
        openProject(dir);
        return json(res, 200, { ok: true, path: dir });
      }
      if (route === "POST /api/project/clone") {
        const b = await readBody(req);
        let src = String(b.url ?? "").trim();
        need(src, "Paste the GitHub link your team lead shared.");
        const m = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(src) ?? /^([\w.-]+\/[\w.-]+)$/.exec(src);
        need(m, "That does not look like a GitHub repo link (https://github.com/owner/name).");
        const slugName = m![1];
        const parent = resolve(String(b.parent || join(homedir(), "hackathons")));
        mkdirSync(parent, { recursive: true });
        const dir = join(parent, slugName.split("/")[1]);
        if (existsSync(dir) && isGitRepo(dir)) {
          await run("git", ["pull", "-q", "--ff-only"], { cwd: dir, timeoutMs: 60_000 });
        } else {
          const c = await run("gh", ["repo", "clone", slugName, dir], { timeoutMs: 180_000 });
          need(c.code === 0, `Could not clone: ${(c.stderr || c.stdout).trim().slice(0, 300)}. Did the lead invite your GitHub account?`);
        }
        openProject(dir);
        return json(res, 200, { ok: true, path: dir });
      }
      if (route === "POST /api/project/close") {
        root = null;
        observer = undefined;
        return json(res, 200, { ok: true });
      }
      if (route === "POST /api/project/pull") {
        need(root, "No project open.");
        const r = await run("git", ["pull", "-q", "--ff-only"], { cwd: root!, timeoutMs: 60_000 });
        observer = undefined;
        return json(res, r.code === 0 ? 200 : 400, r.code === 0 ? { ok: true } : { error: r.stderr.trim() });
      }
      if (route === "POST /api/practice") {
        const { dir, clones } = createPractice(join(USER_DIR, "practice"));
        for (const [id, c] of Object.entries(clones)) {
          mkdirSync(join(c, ".relay", "local"), { recursive: true });
          writeFileSync(join(c, ".relay", "local", "node"), id);
        }
        openProject(clones.ethan);
        for (const [id, c] of Object.entries(clones)) {
          const logFd = openSync(join(dir, `${id}.log`), "a");
          spawn(process.execPath, [LAUNCHER, "start", "--node", id, "--skip-preflight", "--no-dashboard", "--no-keep-awake"], { cwd: c, detached: true, windowsHide: true, stdio: ["ignore", logFd, logFd] }).unref();
        }
        return json(res, 200, { ok: true });
      }

      // ---------- wizard ----------
      if (route === "PUT /api/setup") {
        need(root, "Open or create a project first.");
        const s = Setup.parse(await readBody(req));
        saveSetup(root!, s);
        observer = undefined;
        return json(res, 200, { ok: true, setup: loadSetup(root!) });
      }
      if (route === "GET /api/setup/template") {
        res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "content-disposition": 'attachment; filename="hackathon-brief.md"' });
        return res.end(readFileSync(join(HERE, "..", "templates", "brief.md")));
      }
      if (route === "POST /api/setup/autofill") {
        need(root, "Open or create a project first.");
        const b = await readBody(req);
        const md = String(b.markdown ?? "");
        need(md.trim().length > 20, "That file looks empty.");
        need(md.length < 400_000, "That file is too large for a brief (keep it under 400 KB).");
        mkdirSync(paths(root!).dir, { recursive: true });
        writeFileSync(join(paths(root!).dir, "brief.md"), md);
        const current = b.current ? Setup.parse(b.current) : loadSetup(root!);
        return json(res, 200, await autofill(md, current, { ai: b.ai !== false }));
      }
      if (route === "POST /api/me") {
        need(root, "No project open.");
        const b = await readBody(req);
        need(typeof b.node === "string" && b.node, "Pick a teammate.");
        setMyNode(b.node);
        return json(res, 200, { ok: true });
      }
      if (route === "POST /api/plan") {
        need(root && hasRun(), "Save the team first.");
        need(!planJob.running, "The planner is already running.");
        const b = await readBody(req);
        Object.assign(planJob, { running: true, log: ["Reading the idea…"], ok: undefined, error: undefined });
        void plan(root!, (s) => planJob.log.push(s.slice(0, 300)), b.agent === "codex" ? "codex" : "claude")
          .then((r) => {
            planJob.ok = r.ok;
            if (r.ok) {
              adoptPlannerChecks(root!);
              planJob.log.push(`Planned ${r.tasks} tasks.`);
            } else planJob.error = r.errors ?? "The planner did not produce a valid task list.";
          })
          .catch((e) => {
            planJob.ok = false;
            planJob.error = String(e).slice(0, 500);
          })
          .finally(() => (planJob.running = false));
        return json(res, 200, { ok: true });
      }
      if (route === "GET /api/plan") return json(res, 200, { ...planJob, log: planJob.log.slice(-40) });
      if (route === "GET /api/tasks") {
        need(root, "No project open.");
        const f = paths(root!).tasks;
        const raw = existsSync(f) ? readFileSync(f, "utf8") : "tasks: []\n";
        return json(res, 200, { yaml: raw, tasks: (YAML.parse(raw)?.tasks ?? []) as Task[] });
      }
      if (route === "PUT /api/tasks") {
        need(root, "No project open.");
        const b = await readBody(req);
        const f = paths(root!).tasks;
        let doc: Record<string, unknown>;
        if (typeof b.yaml === "string") doc = YAML.parse(b.yaml);
        else {
          doc = existsSync(f) ? YAML.parse(readFileSync(f, "utf8")) ?? {} : {};
          doc.tasks = b.tasks;
        }
        const parsed = TaskFile.safeParse(doc);
        need(parsed.success, `Task list problem: ${parsed.success ? "" : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
        try {
          validateTasks(parsed.data!.tasks);
        } catch (e) {
          need(false, String((e as Error).message));
        }
        writeFileSync(f, YAML.stringify(doc));
        return json(res, 200, { ok: true });
      }
      if (route === "GET /api/share") {
        need(root, "No project open.");
        const st = await run("git", ["status", "--porcelain"], { cwd: root!, timeoutMs: 10_000 });
        return json(res, 200, { files: st.stdout.split("\n").filter(Boolean).map((l) => l.slice(3)), repo: await ghRepo() });
      }
      if (route === "POST /api/share") {
        // Create the team board (once), commit the plan, push it to the base branch.
        need(root && hasRun(), "Save the team first.");
        const repo = await ghRepo();
        need(repo, "This folder is not connected to a GitHub repo (no `origin`).");
        const p = paths(root!);
        const doc = YAML.parse(readFileSync(p.config, "utf8"));
        const steps: string[] = [];
        if (doc.board?.kind !== "file" && !doc.board?.issue) {
          const setup = loadSetup(root!);
          const body = `Message board for Relay agents${setup.event.name ? ` (${setup.event.name})` : ""}. Agents post structured updates here while they work. Post \`relay stop\` to stop every computer.`;
          const r = await run("gh", ["issue", "create", "--repo", repo!, "--title", "Relay team board", "--body", body], { cwd: root!, timeoutMs: 60_000 });
          need(r.code === 0, `Could not create the board issue: ${r.stderr.trim().slice(0, 200)}`);
          const num = Number(/\/issues\/(\d+)/.exec(r.stdout)?.[1]);
          need(num, "Could not read the new issue number.");
          doc.board = { kind: "github", repo, issue: num };
          writeFileSync(p.config, YAML.stringify(doc));
          steps.push(`Created the team board: issue #${num}`);
          observer = undefined;
        }
        // A changed plan is a new run: every computer reads the same id from relay.yaml.
        const planChanged = (await run("git", ["status", "--porcelain", "--", ".relay/tasks.yaml"], { cwd: root!, timeoutMs: 10_000 })).stdout.trim() !== "";
        if (planChanged || !doc.run_id || doc.run_id === "auto") {
          doc.run_id = newRunId();
          writeFileSync(p.config, YAML.stringify(doc));
          steps.push(`New run ${doc.run_id}`);
          runCache = null;
          observer = undefined;
        }
        // One setup megaprompt per teammate, committed with the plan.
        const setupNow = loadSetup(root!);
        if (setupNow.team.length) {
          const written = writeTeammatePrompts(root!, { setup: setupNow, cfg: loadConfig(root!), tasks: safeTasks(root!), repo: repo!, leadName: setupNow.team[0].name });
          steps.push(`Wrote ${written.length} teammate setup prompt${written.length === 1 ? "" : "s"}`);
        }
        await run("git", ["add", "-A"], { cwd: root!, timeoutMs: 30_000 });
        const c = await run("git", ["commit", "-q", "-m", "Relay: plan"], { cwd: root!, timeoutMs: 30_000 });
        if (c.code === 0) steps.push("Committed the plan");
        const base = doc.base_branch ?? "main";
        let push = await run("git", ["push", "-q", "origin", `HEAD:${base}`], { cwd: root!, timeoutMs: 120_000 });
        if (push.code !== 0) {
          await run("git", ["pull", "-q", "--rebase", "origin", base], { cwd: root!, timeoutMs: 120_000 });
          push = await run("git", ["push", "-q", "origin", `HEAD:${base}`], { cwd: root!, timeoutMs: 120_000 });
        }
        need(push.code === 0, `Push failed: ${push.stderr.trim().slice(0, 300)}`);
        steps.push(`Pushed to ${repo} (${base})`);
        return json(res, 200, { ok: true, steps, repo, link: `https://github.com/${repo}` });
      }
      if (route === "GET /api/onboarding") {
        // Setup megaprompts, generated fresh from the current plan (also saved on Share).
        need(root && hasRun(), "Save the team first.");
        const setupNow = loadSetup(root!);
        const repo = (await ghRepo()) ?? "OWNER/REPO";
        const cfg = loadConfig(root!);
        const tasks = safeTasks(root!);
        return json(res, 200, {
          repo,
          prompts: setupNow.team.map((member) => ({
            id: member.id,
            name: member.name,
            os: member.os,
            agent: member.agent,
            markdown: teammatePrompt({ setup: setupNow, cfg, tasks, member, repo, leadName: setupNow.team[0]?.name ?? "the lead" }),
          })),
        });
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/onboarding/") && url.pathname.endsWith(".md")) {
        need(root && hasRun(), "Save the team first.");
        const id = decodeURIComponent(url.pathname.slice("/api/onboarding/".length, -3));
        const setupNow = loadSetup(root!);
        const member = setupNow.team.find((x) => x.id === id);
        need(member, "No such teammate.");
        const repo = (await ghRepo()) ?? "OWNER/REPO";
        const md = teammatePrompt({ setup: setupNow, cfg: loadConfig(root!), tasks: safeTasks(root!), member: member!, repo, leadName: setupNow.team[0]?.name ?? "the lead" });
        res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="relay-setup-${id}.md"` });
        return res.end(md);
      }
      if (route === "POST /api/invite") {
        need(root, "No project open.");
        const b = await readBody(req);
        const login = String(b.github ?? "").trim();
        need(/^[A-Za-z0-9-]+$/.test(login), "Enter a GitHub username.");
        const repo = await ghRepo();
        need(repo, "No GitHub repo for this folder.");
        const r = await run("gh", ["api", "-X", "PUT", `repos/${repo}/collaborators/${login}`, "-f", "permission=push"], { timeoutMs: 30_000 });
        need(r.code === 0, `GitHub said: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
        return json(res, 200, { ok: true, note: r.stdout.trim() ? "Invitation sent. They accept it from their GitHub email or notifications." : "They already have access." });
      }

      // ---------- this computer ----------
      if (route === "POST /api/preflight") {
        need(root && myNode(), "Pick which teammate you are first.");
        const live2 = url.searchParams.get("live") !== "0";
        const checks = await preflight(root!, myNode()!, { live: live2 });
        const ok = !checks.some((c) => c.status === "fail");
        let posted = false;
        if (ok) {
          const cfg = loadConfig(root!);
          if (cfg.board.kind === "file" || cfg.board.issue) {
            await postEnv("ready", "is ready to run (checks passed).", { os: OS_NAME }).then(() => (posted = true)).catch(() => {});
          }
        }
        return json(res, 200, { checks, ok, posted });
      }
      if (route === "POST /api/autostart") {
        need(root, "No project open.");
        const b = await readBody(req);
        settings.autoStart[root!] = !!b.on;
        saveSettings(settings);
        return json(res, 200, { ok: true });
      }
      if (route === "POST /api/start") {
        need(root && myNode(), "Pick which teammate you are first.");
        if (live || daemonPid()) return json(res, 409, { error: "Already running on this computer." });
        const b = await readBody(req);
        if (b.everyone) await postEnv("go", b.again ? "restarted the run for everyone." : "started the run for everyone.").catch(() => {});
        return json(res, 200, { ok: true, pid: startNode(!!b.again) });
      }
      if (route === "POST /api/stop") {
        need(root && myNode(), "No project open.");
        const team = url.searchParams.get("team") === "1";
        const dir = join(paths(root!).local, myNode()!);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "STOP"), new Date().toISOString());
        if (team) await postEnv("stop", "stopped the run for everyone.").catch(() => {});
        if (live) live.stop(team ? "team stop" : "stopped from the app");
        return json(res, 200, { ok: true, team });
      }

      // ---------- live & results ----------
      if (route === "GET /api/snapshot") {
        await currentRun();
        const dm = getObserver();
        need(dm, "Finish the setup first.");
        if (!live) await dm!.refreshStates().catch(() => {});
        const msgs = await boardMsgs();
        if (!live) for (const m of msgs) dm!.ingest(m, true);
        const n = dm!.runId;
        return json(res, 200, {
          ...dm!.snapshot(),
          live: !!live,
          daemonPid: live ? process.pid : daemonPid(),
          board: msgs.filter((m) => !m.env?.runId || m.env.runId === n).slice(-300).map((m) => ({ id: m.id, author: m.author, createdAt: m.createdAt, text: m.text.split("\n")[0], env: m.env })),
          ledger: (live ? dm!.ledger.tail(200) : dm!.ledger.all().slice(-200)),
        });
      }
      if (route === "GET /api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(": hello\n\n");
        sse.add(res);
        req.on("close", () => sse.delete(res));
        return;
      }
      if (route === "POST /api/reserve") {
        // Folders the humans are editing right now. Agents treat them as taken.
        need(root && myNode(), "No project open.");
        const b = await readBody(req);
        const globs = (Array.isArray(b.globs) ? b.globs : []).map((g: unknown) => String(g).trim()).filter(Boolean).slice(0, 30);
        await postEnv("reserve", globs.length ? `is working on ${globs.join(", ")} (agents keep out).` : "is done with their reserved folders.", { globs });
        return json(res, 200, { ok: true, globs });
      }
      if (route === "POST /api/retry") {
        // Results: retry a set-aside task with a human hint, as a new task <id>-rN.
        need(root && myNode(), "No project open.");
        await currentRun();
        const dm = getObserver();
        need(dm, "Finish the setup first.");
        const b = await readBody(req);
        await dm!.refreshStates();
        const orig = dm!.tasks.find((t) => t.id === String(b.task));
        need(orig, "No such task.");
        const st = dm!.states.get(orig!.id)?.state;
        need(st?.status === "parked", "Only set-aside tasks can be retried.");
        const base = orig!.retry_of ?? orig!.id;
        let n = 2;
        while (dm!.tasks.some((t) => t.id === `${base}-r${n}`)) n++;
        const id = `${base}-r${n}`;
        const hint = String(b.hint ?? "").trim();
        const kept = `relay-work/${dm!.runId}/${orig!.id}-a${st!.attempt}`;
        const brief = `${orig!.brief || orig!.title}\n\n## This is a retry\nThe previous attempt (${orig!.id}) was set aside: ${st!.note ?? "no reason recorded"}\nIts work is kept on the branch \`${kept}\` if it helps (read it with \`git show ${kept}:<path>\` or \`git diff HEAD ${kept}\`).${hint ? `\n\n## Hint from the team\n${hint}` : ""}`;
        const { fake, ...rest } = orig!;
        await dm!.addDynamicTask({ ...rest, id, retry_of: base, brief, ...(fake ? { fake: { ...fake, fail: false, review: "approve", stuck: false } } : {}) }, `Retrying ${orig!.id} as ${id}${hint ? " with a hint from the team" : ""}.`);
        return json(res, 200, { ok: true, id });
      }
      if (route === "POST /api/submission") {
        need(root && myNode(), "No project open.");
        const runId = await currentRun();
        need(runId, "Finish the setup first.");
        return json(res, 200, await draftSubmission(root!, myNode()!, runId!));
      }
      if (route === "POST /api/submission/commit") {
        need(root && myNode(), "No project open.");
        const b = await readBody(req);
        need(typeof b.markdown === "string" && b.markdown.trim(), "Nothing to add.");
        const runId = await currentRun();
        const sha = await commitSubmission(root!, myNode()!, runId!, b.markdown);
        return json(res, 200, { ok: true, sha });
      }
      if (route === "GET /api/report") {
        need(root && myNode(), "No project open.");
        return json(res, 200, await buildReport(root!, myNode()!, await currentRun()));
      }
      if (route === "POST /api/report/pr") {
        need(root && myNode(), "No project open.");
        const runId = await currentRun();
        const r = await buildReport(root!, myNode()!, runId);
        return json(res, 200, { url: await openRunPr(root!, r, runId) });
      }

      // ---------- static app ----------
      let file = join(DIST, url.pathname === "/" ? "index.html" : url.pathname);
      if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html");
      if (!existsSync(file)) {
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end("The app is not built. Run: npm run build:dashboard");
      }
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(readFileSync(file));
    } catch (e) {
      const err = e as Error & { status?: number };
      json(res, err.status ?? 500, { error: err.message ?? String(e) });
    }
  });

  // Live events: the in-process ledger when running; otherwise tail this computer's ledger file.
  const push = (e: unknown) => {
    for (const c of sse) c.write(`data: ${JSON.stringify(e)}\n\n`);
  };
  if (live) live.ledger.on("event", push);
  else {
    let seen = -1;
    let key = "";
    setInterval(() => {
      const d = getObserver();
      if (!d) return;
      const k = `${root}|${myNode()}`;
      const all = d.ledger.all();
      if (k !== key || seen < 0) {
        key = k;
        seen = all.length;
        return;
      }
      for (const e of all.slice(seen)) push(e);
      seen = all.length;
    }, 2000).unref();
  }
  setInterval(() => push({ kind: "ping", at: Date.now() }), 15_000).unref();

  // Auto-start: when this computer opted in and a teammate posts "go", start the node (any time of day).
  // A "go" older than this computer's last stop is ignored, so stopping here sticks.
  setInterval(async () => {
    try {
      if (live || !root || !settings.autoStart[root] || !myNode() || daemonPid()) return;
      const stopFile = join(paths(root).local, myNode()!, "STOP");
      const stoppedAt = existsSync(stopFile) ? statSync(stopFile).mtimeMs : 0;
      const msgs = await boardMsgs();
      const go = msgs.filter((m) => m.env?.type === "go" && m.env.from !== myNode() && m.env.at > stoppedAt).pop();
      if (!go) return;
      // The lead may have shared a newer plan (a new run id): pull it before starting.
      if (go.env!.runId && go.env!.runId !== runName(loadConfig(root))) await run("git", ["pull", "-q", "--ff-only"], { cwd: root, timeoutMs: 120_000 });
      if (go.env!.runId && go.env!.runId !== runName(loadConfig(root))) return;
      startNode();
    } catch {
      /* try again next tick */
    }
  }, 20_000).unref();

  const port = o.port ?? 4545;
  server.on("error", (e) => console.error(`app not started on :${port}: ${String(e)}`));
  server.listen(port, "127.0.0.1");
  return { server, port };
}

function safeTasks(root: string) {
  try {
    return loadTasks(root);
  } catch {
    return [];
  }
}
