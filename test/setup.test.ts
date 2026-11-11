// The onboarding wizard's backend: answers → night.yaml/idea.md, and the app's HTTP API.
import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { Setup, saveSetup, loadSetup } from "../src/setup.js";
import { loadNight, paths } from "../src/config.js";
import { serve } from "../src/server.js";
import { shellArgv, resolveCli } from "../src/platform.js";
import { makeTeam } from "./helpers.js";

const answers = () =>
  Setup.parse({
    event: { name: "HackTX 2027", track: "Build something for first responders", deadline: "2027-10-20T09:00" },
    idea: { pitch: "Radio-to-text handoffs", demo: "1. record\n2. brief", stack: "Next.js + FastAPI" },
    team: [
      { name: "Ethan Meza", github: "ethnmz", os: "mac", agent: "claude", roles: "Frontend, design & demo" },
      { name: "Sam", os: "windows", agent: "codex", roles: "backend" },
      { name: "Riley", os: "windows", agent: "claude", roles: "" },
    ],
    rules: { perComputer: 3, usageCap: 10, review: true, stealing: false, contractsOwner: "", check: "npm test" },
  });

describe("setup answers become the night's config", () => {
  it("any team size, roles → lanes, per-teammate agents, plain rules → pre-authorizations", () => {
    const team = makeTeam({ tasks: [] });
    const root = team.clones.ethan;
    saveSetup(root, answers());
    const cfg = loadNight(root);
    expect(cfg.nodes.map((n) => [n.id, n.lanes, n.agent])).toEqual([
      ["ethan-meza", ["frontend", "design-demo"], "claude"],
      ["sam", ["backend"], "codex"],
      ["riley", ["riley"], "claude"], // no role given: their own lane
    ]);
    expect(cfg.authorize.work_stealing).toBe(false);
    expect(cfg.concurrency).toBe(3);
    expect(cfg.budget).toEqual({ node_usd: 10, team_usd: 30 });
    expect(cfg.check).toBe("npm test");
    expect(cfg.contract_lane).toBe("frontend");
    expect(cfg.auth).toBe("subscription");
    const idea = readFileSync(paths(root).idea, "utf8");
    expect(idea).toContain("HackTX 2027");
    expect(idea).toContain("first responders");
    expect(idea).toContain("Sam: backend · windows · Codex");
    expect(loadSetup(root).team[1].id).toBe("sam");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".nightshift/local/");
  });

  it("re-saving keeps hand-edited advanced settings and the board issue", () => {
    const team = makeTeam({ tasks: [], night: { board: { kind: "github", repo: "o/r", issue: 7 }, gate: { command: "make e2e", every: 2 } } });
    const root = team.clones.ethan;
    saveSetup(root, answers());
    const cfg = loadNight(root);
    expect(cfg.board).toEqual({ kind: "github", repo: "o/r", issue: 7 });
    expect(cfg.gate).toEqual({ command: "make e2e", every: 2 });
  });
});

describe("app API", () => {
  const servers: { close: () => void }[] = [];
  afterAll(() => servers.forEach((s) => s.close()));
  it("open → save setup → pick me → save tasks (validated) → snapshot", async () => {
    const team = makeTeam({ tasks: [] });
    const { server } = serve({ root: null, port: 0 });
    servers.push(server);
    await new Promise((r) => server.once("listening", r));
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(base + path, { method, body: body ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json" } });
      return { status: r.status, json: (await r.json()) as any };
    };
    expect((await call("GET", "/api/app")).json.project).toBeNull();
    expect((await call("POST", "/api/project/open", { path: "/definitely/not/here" })).status).toBe(400);
    expect((await call("POST", "/api/project/open", { path: team.clones.ethan })).status).toBe(200);
    // Keep the file board from the fixture; the wizard only rewrites the team and rules.
    const saved = await call("PUT", "/api/setup", { ...answers(), team: [{ name: "Ethan", os: "mac", agent: "claude", roles: "frontend" }] });
    expect(saved.status).toBe(200);
    expect((await call("POST", "/api/me", { node: "ethan" })).status).toBe(200);
    const bad = await call("PUT", "/api/tasks", { tasks: [{ id: "A", title: "a", lane: "frontend", lease: ["a/**"], depends_on: ["B"] }, { id: "B", title: "b", lane: "frontend", lease: ["b/**"], depends_on: ["A"] }] });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/cycle/);
    const good = await call("PUT", "/api/tasks", { tasks: [{ id: "A", title: "a", lane: "frontend", lease: ["a/**"] }] });
    expect(good.status).toBe(200);
    const app = (await call("GET", "/api/app")).json;
    expect(app.me).toBe("ethan");
    expect(app.project.tasks).toBe(1);
    const snap = await call("GET", "/api/snapshot");
    expect(snap.status).toBe(200);
    expect(snap.json.tasks.map((t: any) => [t.id, t.readiness])).toEqual([["A", "ready"]]);
    // Requests that claim another Host (DNS rebinding from a web page) are refused.
    const status = await new Promise<number>((res) => {
      const port = (server.address() as AddressInfo).port;
      request({ host: "127.0.0.1", port, path: "/api/app", headers: { host: "evil.example" } }, (r) => res(r.statusCode ?? 0)).end();
    });
    expect(status).toBe(403);
  }, 30_000);
});

describe("platform", () => {
  it("checks run in bash; .js/.mjs agent overrides run with node", () => {
    expect(shellArgv("echo hi")[0]).toMatch(/bash(\.exe)?$/);
    expect(resolveCli("codex", "/x/fake-codex.mjs")).toEqual([process.execPath, ["/x/fake-codex.mjs"]]);
  });
});
