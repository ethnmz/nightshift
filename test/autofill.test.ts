import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { autofill, parseMemberLine, parseBrief } from "../src/autofill.js";
import { Setup, saveSetup, loadSetup } from "../src/setup.js";
import { loadConfig, paths } from "../src/config.js";
import { makeTeam } from "./helpers.js";

const TEMPLATE = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "..", "templates", "brief.md"), "utf8");
const empty = () => Setup.parse({});

describe("autofill from a markdown brief (no AI)", () => {
  it("fills every field from the template", async () => {
    const r = await autofill(TEMPLATE, empty(), { ai: false });
    const s = r.setup;
    expect(s.event.name).toBe("HackUTD 2027");
    expect(s.event.deadline).toBe("2027-11-09T09:00");
    expect(s.event.track).toContain("sponsor");
    expect(s.idea.pitch).toContain("what we are building");
    expect(s.idea.demo).toMatch(/^1\. /);
    expect(s.idea.must).toContain("deadline");
    expect(s.idea.nice).toContain("time");
    expect(s.idea.stack).toContain("FastAPI");
    expect(s.idea.rules).toContain("Never invent");
    expect(s.event.links).toContain("https://example.com");
    expect(s.team.map((m) => [m.name, m.github, m.os, m.agent, m.roles])).toEqual([
      ["Ethan Meza", "ethnmz", "mac", "claude", "frontend, demo"],
      ["Teammate Two", "their-github", "windows", "codex", "AI"],
      ["Teammate Three", "their-github", "windows", "claude", "backend"],
    ]);
    expect(s.rules).toMatchObject({ perComputer: 2, usageCap: 25, review: true, stealing: true, check: "npm test" });
    expect(r.filled).toEqual(expect.arrayContaining(["event", "deadline", "idea", "demo", "team (3 people)", "agent rules"]));
    expect(r.usedAI).toBe(false);
  });

  it("handles a messy freeform brief and keeps what the wizard already had", async () => {
    const md = `# ShiftSync

We're making a voice handoff tool for data center operators.

Deadline: Sunday Nov 9 2027 9:00 AM

### The Prompt
NMC² wants better shift handoffs.

### What we'll demo
- Record a handoff
- Incoming operator gets a briefing

### Who's who
* Diego Lozano (@Navibytes) – Windows – Codex – voice, bridge
* Akshi on Windows with Codex, AI
`;
    const current = empty();
    current.idea.stack = "Python + React";
    const r = await autofill(md, current, { ai: false });
    expect(r.setup.event.name).toBe("ShiftSync");
    expect(r.setup.event.track).toContain("NMC²");
    expect(r.setup.event.deadline).toBe("2027-11-09T09:00");
    expect(r.setup.idea.demo).toContain("Record a handoff");
    expect(r.setup.idea.stack).toBe("Python + React"); // not in the brief: untouched
    expect(r.setup.team[0]).toMatchObject({ name: "Diego Lozano", github: "Navibytes", os: "windows", agent: "codex" });
    expect(r.setup.team[1]).toMatchObject({ name: "Akshi", os: "windows", agent: "codex", roles: "AI" });
  });

  it("a long title that mentions 'team' is the event name, not a team section", () => {
    const r = parseBrief("# Notes for HackTX 2027 – team Owl\n\nWe want to build Quiet Hours.\n\n- Maya @mayac Mac\n");
    expect(r.found.name).toContain("HackTX");
    expect(r.weak.has("name")).toBe(true);
    expect(r.team).toEqual([]);
    expect(r.found.pitch).toContain("Quiet Hours");
  });

  it("member lines in several shapes", () => {
    expect(parseMemberLine("| Sam | @sam-k | Linux | Claude Code | data |")).toMatchObject({ name: "Sam", github: "sam-k", os: "linux", agent: "claude", roles: "data" });
    expect(parseMemberLine("- Riley (github.com/rileyb) - Mac - backend")).toMatchObject({ name: "Riley", github: "rileyb", os: "mac", roles: "backend" });
    expect(parseMemberLine("Name | GitHub | OS")).toBeNull();
    expect(parseMemberLine("|---|---|")).toBeNull();
  });

  it("the brief is kept for the planner and the contracts owner name maps to an id", async () => {
    const team = makeTeam({ tasks: [] });
    const root = team.clones.ethan;
    const r = await autofill(TEMPLATE.replace("Shared contracts owner: Ethan Meza", "Shared contracts owner: Teammate Two"), empty(), { ai: false });
    expect(r.setup.rules.contractsOwner).toBe("Teammate Two");
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(paths(root).dir, { recursive: true });
    writeFileSync(join(paths(root).dir, "brief.md"), TEMPLATE);
    saveSetup(root, r.setup);
    expect(loadSetup(root).rules.contractsOwner).toBe("teammate-two");
    expect(loadConfig(root).contract_lane).toBe("ai");
    const idea = readFileSync(paths(root).idea, "utf8");
    expect(idea).toContain("## The team's original brief");
    expect(idea).not.toContain("<!--");
  });
});
