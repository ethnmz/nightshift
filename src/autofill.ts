// Autofill the setup from a markdown brief the team wrote (or pasted notes).
// Two passes:
//   1. A deterministic parser for headings and "Key: value" lines (instant, exact on the template).
//   2. Optionally, the lead's agent (Claude Code on their subscription) reads the whole brief with a
//      JSON schema and fills in what the parser could not place.
// Values the parser found win over the AI's. Nothing already typed in the wizard is overwritten
// unless the brief has a value for it.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Setup, type Member } from "./setup.js";
import { childEnv } from "./exec.js";
import { KEY_ENV } from "./config.js";

type Section = "name" | "track" | "deadline" | "pitch" | "problem" | "demo" | "must" | "nice" | "stack" | "rules" | "team" | "agentRules" | "links";

const HEADINGS: [Section, RegExp][] = [
  ["track", /challenge|track|prompt|theme|sponsor/i],
  ["deadline", /deadline|due|submission/i],
  ["demo", /demo/i],
  ["must", /must[- ]?have|requirements?|mvp|p0|scope/i],
  ["nice", /nice[- ]?to[- ]?have|stretch|p1|bonus|extras?/i],
  ["stack", /stack|tech|technolog|tools?$/i],
  ["agentRules", /overnight|night rules|agent rules|run rules|settings|config/i],
  ["rules", /rules|constraints|guidelines|do not|don't/i],
  ["team", /team|members|people|who/i],
  ["problem", /problem|users?|audience|why/i],
  ["pitch", /idea|pitch|summary|overview|what we|project|concept/i],
  ["links", /links?|resources|references|docs/i],
  ["name", /event|hackathon/i],
];

const clean = (s: string) =>
  s
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

function classify(heading: string): Section | null {
  for (const [k, re] of HEADINGS) if (re.test(heading)) return k;
  return null;
}

const OS_RE = /\b(mac\s?os|macbook|mac|osx|windows(?:\s1[01])?|win|pc|linux|ubuntu)\b/i;
const AGENT_RE = /\b(claude code|claude|openai codex|codex|chatgpt)\b/i;
const osOf = (w: string): Member["os"] => (/^(win|windows|pc)/i.test(w) ? "windows" : /^(linux|ubuntu)/i.test(w) ? "linux" : "mac");
const agentOf = (w: string): Member["agent"] => (/codex|chatgpt/i.test(w) ? "codex" : "claude");

/** "Ethan Meza | @ethnmz | Mac | Claude Code | frontend, demo" and looser variants. */
export function parseMemberLine(line: string): Partial<Member> | null {
  let l = line.replace(/^\s*([-*+]|\d+[.)])\s+/, "").trim();
  if (!l || /^\|?\s*name\s*\|/i.test(l) || /^[-|:\s]+$/.test(l)) return null;
  const m: Partial<Member> = {};
  // GitHub handle anywhere.
  const gh = /(?:^|[\s(|])@([A-Za-z0-9-]+)|github\.com\/([A-Za-z0-9-]+)/.exec(l);
  if (gh) {
    m.github = gh[1] ?? gh[2];
    l = l.replace(gh[0], gh[0].startsWith("(") ? "(" : " ");
  }
  const os = OS_RE.exec(l);
  if (os) m.os = osOf(os[1]);
  const ag = AGENT_RE.exec(l);
  if (ag) m.agent = agentOf(ag[1]);
  // Remove the keywords (with "on/with/using/uses" glue) so the rest is name + roles.
  l = l
    .replace(new RegExp(String.raw`\b(on|with|using|uses|runs)?\s*` + OS_RE.source, "ig"), " ")
    .replace(new RegExp(String.raw`\b(on|with|using|uses|runs)?\s*` + AGENT_RE.source, "ig"), " ")
    .replace(/[()]/g, " | ");
  const parts = l
    .split(/\s*\|\s*|\s+[–—-]\s+|\s*:\s+/)
    .map((p) => p.replace(/^[-–—,\s]+|[-–—,\s]+$/g, "").replace(/^roles?:?\s*/i, "").trim())
    .filter(Boolean);
  if (!parts.length) return null;
  let name = parts.shift()!;
  const roles = [...parts];
  // "Akshi, AI" in one chunk: the name is the first comma-part.
  if (name.includes(",")) {
    const [n, ...r] = name.split(",").map((x) => x.trim());
    name = n;
    roles.unshift(...r.filter(Boolean));
  }
  if (!name || name.length > 40 || /\s{2,}/.test(name) || name.split(/\s+/).length > 4 || /[:"“”]$|^["“]/.test(name)) return null;
  m.name = name;
  if (roles.length) m.roles = roles.join(", ");
  return m;
}

function parseRules(body: string, team: Partial<Member>[]): Partial<Setup["rules"]> {
  const r: Partial<Setup["rules"]> = {};
  const get = (re: RegExp) => re.exec(body)?.[1]?.trim();
  const per = get(/agents?\s*(?:per|\/)\s*computer\s*[:=]\s*(\d)/i);
  if (per) r.perComputer = Math.min(4, Math.max(1, Number(per)));
  const usage = get(/usage[^:\n]*[:=]\s*([^\n]+)/i);
  if (usage) {
    const u = usage.replace(/\(.*?\)/g, ""); // ignore "(light, normal or heavy)" hints
    r.usageCap = /normal|medium|default/i.test(u) ? 25 : /light|low/i.test(u) ? 10 : /heavy|high|max/i.test(u) ? 60 : Number(/\$?(\d+)/.exec(u)?.[1]) || 25;
  }
  const yes = (s?: string) => (s === undefined ? undefined : !/^(no|false|off|never)\b/i.test(s));
  const review = yes(get(/review[^:\n]*[:=]\s*([^\n]+)/i));
  if (review !== undefined) r.review = review;
  const help = yes(get(/(?:help|steal)[^:\n]*[:=]\s*([^\n]+)/i));
  if (help !== undefined) r.stealing = help;
  const owner = get(/contracts?[^:\n]*[:=]\s*([^\n]+)/i);
  if (owner) {
    const hit = team.find((m) => m.name && owner.toLowerCase().includes(m.name.toLowerCase().split(" ")[0]));
    if (hit?.name) r.contractsOwner = hit.name; // resolved to an id after ids are assigned
  }
  const check = get(/check[^:\n]*[:=]\s*`?([^`\n]+)`?/i);
  if (check) r.check = check;
  return r;
}

export interface AutofillResult {
  setup: Setup;
  filled: string[]; // human labels of what came from the file
  usedAI: boolean;
  aiError?: string;
}

/** Deterministic pass. Returns only what it found. */
export function parseBrief(md: string): { found: Partial<Record<Section, string>>; weak: Set<Section>; team: Partial<Member>[]; rules: Partial<Setup["rules"]> } {
  const weak = new Set<Section>(); // guesses (title as name, opening paragraph as idea) that a smarter reader may beat
  const text = md.replace(/\r\n/g, "\n");
  const found: Partial<Record<Section, string>> = {};
  const lines = text.split("\n");
  let current: Section | null = null;
  let buf: string[] = [];
  let preamble = "";
  const flush = () => {
    if (!current && buf.length) preamble += "\n" + buf.join("\n");
    if (current && buf.length) {
      const v = clean(buf.join("\n"));
      if (v) found[current] = found[current] ? `${found[current]}\n${v}` : v;
    }
    buf = [];
  };
  for (const line of lines) {
    const h = /^(#{1,4})\s+(.+?)\s*#*$/.exec(line);
    if (h) {
      flush();
      const title = h[2].trim();
      // "# Event: HackUTD 2027" or a level-1 title is the event / project name.
      const kv = /^(event|hackathon|project)\s*[:—-]\s*(.+)$/i.exec(title);
      if (kv) {
        found.name = kv[2].trim();
        current = null;
        continue;
      }
      // A top-level title is the event/project name unless it is just a section word ("# Team").
      if (h[1] === "#" && !found.name && (!classify(title) || title.split(/\s+/).length > 3)) {
        found.name = title;
        weak.add("name");
        current = null;
        continue;
      }
      current = classify(title);
      continue;
    }
    // Key: value lines anywhere (outside sections or at their top).
    const kv = /^\s*(?:[-*]\s*)?\**(deadline|due|submission|event|hackathon|track|stack|tech stack|idea|pitch)\**\s*[:=]\s*(.+)$/i.exec(line);
    if (kv && (current === null || current === "pitch" || current === "name")) {
      const k = classify(kv[1]) ?? (/event|hackathon/i.test(kv[1]) ? "name" : null);
      if (k && !found[k]) {
        found[k] = kv[2].trim();
        continue;
      }
    }
    buf.push(line);
  }
  flush();
  // Text before the first section (e.g. under the title) is the idea when there is no idea section.
  const pre = clean(preamble);
  if (pre && !found.pitch) {
    found.pitch = pre;
    weak.add("pitch");
  }
  const team: Partial<Member>[] = [];
  if (found.team) for (const l of found.team.split("\n")) {
    const m = parseMemberLine(l);
    if (m) team.push(m);
  }
  const rules = found.agentRules ? parseRules(found.agentRules, team) : {};
  return { found, weak, team, rules };
}

const AI_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    event: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, track: { type: "string" }, deadline: { type: "string", description: "ISO local datetime YYYY-MM-DDTHH:MM if known, else empty" }, links: { type: "string" } }, required: ["name", "track", "deadline", "links"] },
    idea: {
      type: "object",
      additionalProperties: false,
      properties: { pitch: { type: "string" }, problem: { type: "string" }, demo: { type: "string" }, must: { type: "string" }, nice: { type: "string" }, stack: { type: "string" }, rules: { type: "string" } },
      required: ["pitch", "problem", "demo", "must", "nice", "stack", "rules"],
    },
    team: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { name: { type: "string" }, github: { type: "string" }, os: { type: "string", enum: ["mac", "windows", "linux", ""] }, agent: { type: "string", enum: ["claude", "codex", ""] }, roles: { type: "string" } },
        required: ["name", "github", "os", "agent", "roles"],
      },
    },
    rules: {
      type: "object",
      additionalProperties: false,
      properties: { perComputer: { type: "integer" }, usageCap: { type: "integer" }, review: { type: "boolean" }, stealing: { type: "boolean" }, contractsOwnerName: { type: "string" }, check: { type: "string" } },
      required: [],
    },
  },
  required: ["event", "idea", "team"],
};

async function aiExtract(md: string, model?: string): Promise<Record<string, any>> {
  const prompt = `Read this hackathon brief written by a team and fill in the setup form for a multi-agent AI build.
Rules: copy the team's own words where possible; keep lists as markdown lists; leave a field as "" when the brief does not say (never invent people, usernames, dates or requirements); "demo" is what the demo must show in order; "rules" are rules the coding agents must follow; for rules.* only include values the brief states.

<brief>
${md.slice(0, 60_000)}
</brief>`;
  let out: unknown;
  let err = "";
  for await (const m of query({
    prompt,
    options: {
      maxTurns: 3,
      model,
      permissionMode: "dontAsk",
      settingSources: [],
      allowedTools: [],
      outputFormat: { type: "json_schema", schema: AI_SCHEMA },
      env: childEnv({}, KEY_ENV),
    },
  })) {
    if (m.type === "result") {
      if (m.subtype === "success") out = (m as { structured_output?: unknown }).structured_output;
      else err = m.subtype;
    }
  }
  if (!out || typeof out !== "object") throw new Error(err || "no structured answer");
  return out as Record<string, any>;
}

const LABEL: Record<string, string> = {
  name: "event", track: "challenge", deadline: "deadline", pitch: "idea", problem: "problem", demo: "demo",
  must: "must-haves", nice: "nice-to-haves", stack: "tech stack", rules: "agent rules", links: "links",
};

/** Normalize "Nov 9 9am" style deadlines when we can; otherwise keep the text out of the date field. */
function toLocalDatetime(s: string): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s.slice(0, 16);
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(s.trim());
  if (m) return `${m[1]}T${(m[2] ?? "09").padStart(2, "0")}:${m[3] ?? "00"}`;
  const d = new Date(s.replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+/i, "").replace(/(\d)(st|nd|rd|th)\b/, "$1").replace(/\s+at\s+/i, " "));
  if (!isNaN(d.getTime()) && /\d/.test(s)) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  return "";
}

export async function autofill(md: string, current: Setup, opts: { ai: boolean; model?: string }): Promise<AutofillResult> {
  const s: Setup = structuredClone(current);
  const filled = new Set<string>();
  const { found, weak, team, rules } = parseBrief(md);
  let ai: Record<string, any> | null = null;
  let aiError: string | undefined;
  if (opts.ai) {
    try {
      ai = await aiExtract(md, opts.model);
    } catch (e) {
      aiError = String((e as Error).message ?? e).slice(0, 200);
    }
  }
  const pick = (k: Section): string => {
    const fromAi = String((k === "name" || k === "track" || k === "deadline" || k === "links" ? ai?.event?.[k] : ai?.idea?.[k]) ?? "").trim();
    // Labeled sections win; weak guesses lose to the AI's reading.
    if (found[k] && !(weak.has(k) && fromAi)) return String(found[k]).trim();
    return fromAi;
  };
  const setIf = (k: Section, apply: (v: string) => void) => {
    const v = pick(k);
    if (v) {
      apply(v);
      filled.add(LABEL[k]);
    }
  };
  setIf("name", (v) => (s.event.name = v.replace(/^#\s*/, "")));
  setIf("track", (v) => (s.event.track = v));
  setIf("links", (v) => (s.event.links = v));
  const dl = toLocalDatetime(pick("deadline"));
  if (dl) {
    s.event.deadline = dl;
    filled.add("deadline");
  }
  setIf("pitch", (v) => (s.idea.pitch = v));
  setIf("problem", (v) => (s.idea.problem = v));
  setIf("demo", (v) => (s.idea.demo = v));
  setIf("must", (v) => (s.idea.must = v));
  setIf("nice", (v) => (s.idea.nice = v));
  setIf("stack", (v) => (s.idea.stack = v));
  setIf("rules", (v) => (s.idea.rules = v));

  // Team: with an AI reading, its list is the base and parser rows only add missing details;
  // without AI, the parser's rows (from a team section) are used.
  const aiTeam = ((ai?.team ?? []) as Partial<Member>[]).filter((a) => a?.name);
  const firstWord = (n?: string) => (n ?? "").toLowerCase().split(/\s+/)[0];
  const people: Partial<Member>[] = aiTeam.length ? aiTeam.map((a) => ({ ...a })) : [...team];
  if (aiTeam.length)
    for (const p of team) {
      const same = people.find((a) => firstWord(a.name) === firstWord(p.name));
      if (same) for (const k of ["github", "os", "agent", "roles"] as const) if (!same[k] && p[k]) (same as any)[k] = p[k];
    }
  if (people.length) {
    s.team = people.slice(0, 8).map((p) => {
      const prev = current.team.find((m) => m.name.toLowerCase() === (p.name ?? "").toLowerCase());
      return {
        id: prev?.id ?? "",
        name: p.name ?? "",
        github: (p.github ?? prev?.github ?? "").replace(/^@/, ""),
        os: (p.os || prev?.os || "mac") as Member["os"],
        agent: (p.agent || prev?.agent || "claude") as Member["agent"],
        roles: p.roles ?? prev?.roles ?? "",
        ...(prev?.model ? { model: prev.model } : {}),
      };
    });
    filled.add(`team (${s.team.length} ${s.team.length === 1 ? "person" : "people"})`);
  }

  const r = { ...(ai?.rules ?? {}), ...rules } as Record<string, any>;
  const ownerName = rules.contractsOwner ?? r.contractsOwnerName;
  if (typeof r.perComputer === "number" && r.perComputer > 0) s.rules.perComputer = Math.min(4, Math.max(1, r.perComputer));
  if (typeof r.usageCap === "number" && r.usageCap > 0) s.rules.usageCap = r.usageCap <= 10 ? 10 : r.usageCap >= 60 ? 60 : 25;
  if (typeof r.review === "boolean") s.rules.review = r.review;
  if (typeof r.stealing === "boolean") s.rules.stealing = r.stealing;
  if (typeof r.check === "string" && r.check) s.rules.check = r.check;
  if (ownerName) s.rules.contractsOwner = String(ownerName); // a name; saveSetup maps it to an id
  if (Object.keys(r).length) filled.add("agent rules");

  return { setup: Setup.parse(s), filled: [...filled], usedAI: !!ai, aiError };
}
