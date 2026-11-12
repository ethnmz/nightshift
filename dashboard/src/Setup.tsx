import { useEffect, useMemo, useState } from "react";
import { api, AppState, Check, EMPTY_SETUP, Member, OS, SetupData, Task, Tools, Agent, Snapshot } from "./api";
import { Button, Card, Code, Copy, Field, Input, Note, Segmented, Text, Toggle, Title, agentLabel, initials } from "./ui";

const STEPS = [
  { id: "event", label: "Hackathon", lead: true },
  { id: "team", label: "Team", lead: true },
  { id: "rules", label: "Rules", lead: true },
  { id: "plan", label: "Plan", lead: true },
  { id: "share", label: "Share", lead: true },
  { id: "computer", label: "Your computer", lead: false },
  { id: "start", label: "Start", lead: false },
] as const;
type StepId = (typeof STEPS)[number]["id"];

const ROLE_IDEAS = ["frontend", "backend", "AI", "data", "mobile", "design & demo", "infra"];
const NIGHTSHIFT_REPO = "https://github.com/ethnmz/nightshift";

function firstStep(app: AppState): StepId {
  if (!app.project?.hasSetup) return "event";
  if (!app.project.tasks) return "plan";
  if (!app.board?.issue && app.board?.kind !== "file") return "share";
  if (!app.me) return "computer";
  return "start";
}

export function SetupWizard({ app, reload, goTonight }: { app: AppState; reload: () => Promise<AppState | null>; goTonight: () => void }) {
  const [step, setStep] = useState<StepId>(() => firstStep(app));
  const [s, setS] = useState<SetupData>(() => structuredClone(app.setup && app.project?.hasSetup ? app.setup : EMPTY_SETUP));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const joined = !!app.project?.hasSetup && !!app.board?.issue; // a teammate who joined a finished setup
  const idx = STEPS.findIndex((x) => x.id === step);

  const save = async () => {
    setSaving(true);
    setErr("");
    try {
      const r = await api.saveSetup(s);
      setS(r.setup);
      await reload();
      return true;
    } catch (e) {
      setErr(String((e as Error).message));
      return false;
    } finally {
      setSaving(false);
    }
  };
  const next = async () => {
    if (["event", "team", "rules"].includes(step) && !(await save())) return;
    setStep(STEPS[Math.min(idx + 1, STEPS.length - 1)].id);
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="grid gap-8 md:grid-cols-[200px_1fr]">
      <ol className="flex overflow-x-auto border-night-700 md:flex-col md:border-t">
        {STEPS.map((x, i) => (
          <li key={x.id} className="md:border-b md:border-night-700">
            <button onClick={() => setStep(x.id)} className={`flex w-full items-center gap-3 whitespace-nowrap px-3 py-3 text-left text-sm transition ${step === x.id ? "bg-night-850 text-cream" : "text-neutral-500 hover:text-neutral-200"}`}>
              <span className={`font-mono text-[11px] ${i < idx ? "text-copper" : step === x.id ? "text-cream" : "text-neutral-600"}`}>{i < idx ? "✓ " : ""}{String(i + 1).padStart(2, "0")}</span>
              {x.label}
              {x.lead && joined && <span className="ml-auto text-[10px] text-neutral-600">lead</span>}
            </button>
          </li>
        ))}
      </ol>

      <div className="space-y-4">
        {joined && STEPS[idx].lead && <Note>Your team lead already did this step. You can look, but you only need "Your computer" and "Start".</Note>}
        {step === "event" && <EventStep s={s} setS={setS} />}
        {step === "team" && <TeamStep s={s} setS={setS} />}
        {step === "rules" && <RulesStep s={s} setS={setS} />}
        {step === "plan" && <PlanStep app={app} s={s} />}
        {step === "share" && <ShareStep app={app} s={s} reload={reload} />}
        {step === "computer" && <ComputerStep app={app} s={s} reload={reload} />}
        {step === "start" && <StartStep app={app} reload={reload} goTonight={goTonight} />}
        {err && <Note kind="error">{err}</Note>}
        {step !== "start" && (
          <div className="flex justify-end gap-2">
            {idx > 0 && (
              <Button kind="ghost" onClick={() => setStep(STEPS[idx - 1].id)}>
                Back
              </Button>
            )}
            <Button onClick={next} busy={saving}>
              {["event", "team", "rules"].includes(step) ? "Save and continue" : "Continue"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- 1. Hackathon ----------
function EventStep({ s, setS }: { s: SetupData; setS: (s: SetupData) => void }) {
  const [more, setMore] = useState(!!(s.idea.problem || s.idea.nice || s.event.links));
  const ev = (k: keyof SetupData["event"], v: string) => setS({ ...s, event: { ...s.event, [k]: v } });
  const id = (k: keyof SetupData["idea"], v: string) => setS({ ...s, idea: { ...s.idea, [k]: v } });
  return (
    <div className="space-y-4">
      <BriefUpload s={s} setS={(x) => (setS(x), setMore(!!(x.idea.problem || x.idea.nice || x.event.links)))} />
      <Card className="space-y-5">
      <Head title="Tell us about the hackathon" sub="The AI planner and every agent read this. Plain words are fine. Anything you uploaded shows up here to check and edit." />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Event">
          <Input placeholder="e.g. HackUTD 2026" value={s.event.name} onChange={(e) => ev("name", e.target.value)} />
        </Field>
        <Field label="Submission deadline">
          <Input type="datetime-local" value={s.event.deadline} onChange={(e) => ev("deadline", e.target.value)} />
        </Field>
      </div>
      <Field label="Challenge or track" hint="paste the prompt">
        <Text placeholder="What the sponsors or judges asked for" value={s.event.track} onChange={(e) => ev("track", e.target.value)} />
      </Field>
      <Field label="Your idea" hint="one or two sentences">
        <Text rows={2} placeholder="We are building…" value={s.idea.pitch} onChange={(e) => id("pitch", e.target.value)} />
      </Field>
      <Field label="What the demo must show" hint="in order">
        <Text placeholder={"1. A user records…\n2. …"} value={s.idea.demo} onChange={(e) => id("demo", e.target.value)} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Must-haves">
          <Text placeholder="What has to work tomorrow" value={s.idea.must} onChange={(e) => id("must", e.target.value)} />
        </Field>
        <Field label="Tech stack" hint="optional">
          <Text placeholder="Leave blank and the planner picks something simple" value={s.idea.stack} onChange={(e) => id("stack", e.target.value)} />
        </Field>
      </div>
      <Field label="Rules for the agents" hint="optional">
        <Text placeholder="e.g. no real user data, keep it accessible, never fake sensor readings" value={s.idea.rules} onChange={(e) => id("rules", e.target.value)} />
      </Field>
      {!more ? (
        <button onClick={() => setMore(true)} className="text-sm text-indigo-300 hover:text-indigo-200">
          + Add more detail (problem, nice-to-haves, links)
        </button>
      ) : (
        <div className="space-y-4">
          <Field label="Problem and users">
            <Text value={s.idea.problem} onChange={(e) => id("problem", e.target.value)} />
          </Field>
          <Field label="Nice-to-haves">
            <Text value={s.idea.nice} onChange={(e) => id("nice", e.target.value)} />
          </Field>
          <Field label="Links" hint="docs, APIs, rules">
            <Text rows={2} value={s.event.links} onChange={(e) => ev("links", e.target.value)} />
          </Field>
        </div>
      )}
      </Card>
    </div>
  );
}

/** Drop a markdown brief; Nightshift fills in the whole setup (event, idea, team, rules). */
function BriefUpload({ s, setS }: { s: SetupData; setS: (s: SetupData) => void }) {
  const [busy, setBusy] = useState(false);
  const [ai, setAi] = useState(true);
  const [drag, setDrag] = useState(false);
  const [res, setRes] = useState<{ ok: boolean; t: string } | null>(null);
  const run = async (file: File) => {
    if (!/\.(md|markdown|txt)$/i.test(file.name)) {
      setRes({ ok: false, t: "Use a .md (markdown) or .txt file." });
      return;
    }
    setBusy(true);
    setRes(null);
    try {
      const text = await file.text();
      const r = await api.autofill(text, s, ai);
      setS(r.setup);
      const parts = [`Filled from ${file.name}: ${r.filled.join(", ") || "nothing recognizable"}.`];
      if (ai && !r.usedAI) parts.push(`The AI pass did not run (${r.aiError ?? "unavailable"}), so only clearly labeled sections were used.`);
      else if (r.usedAI) parts.push("AI filled in what the headings didn't say.");
      parts.push("Check each step, then save.");
      setRes({ ok: true, t: parts.join(" ") });
    } catch (e) {
      setRes({ ok: false, t: String((e as Error).message) });
    }
    setBusy(false);
  };
  return (
    <Card className="space-y-4">
      <Title tag="Fastest way" title="Start from your brief" sub="Write your hackathon notes in one markdown file (event, challenge, idea, demo, team, rules), then drop it here. Nightshift fills in every step it can." />
      <label
        onDragOver={(e) => (e.preventDefault(), setDrag(true))}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void run(f);
        }}
        className={`copper-grid flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed px-6 py-10 text-center transition ${drag ? "border-copper bg-copper/10" : "border-night-600 hover:border-cream/50"}`}
      >
        <input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" className="hidden" onChange={(e) => e.target.files?.[0] && void run(e.target.files[0])} />
        {busy ? (
          <>
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-cream border-t-transparent" />
            <span className="text-sm text-neutral-300">{ai ? "Reading your brief (the AI pass can take up to a minute)…" : "Reading your brief…"}</span>
          </>
        ) : (
          <>
            <span className="text-base font-light text-cream">Drop your brief.md here</span>
            <span className="text-xs text-neutral-500">or click to choose a file</span>
          </>
        )}
      </label>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <Toggle on={ai} onChange={setAi} label="Let AI fill in what the headings don't say" hint="Uses your Claude Code subscription for one short read." />
        <a href="/api/setup/template" className="ml-auto text-sm text-neutral-300 underline decoration-night-600 underline-offset-4 hover:text-white">
          Download the brief template
        </a>
      </div>
      {res && <Note kind={res.ok ? "ok" : "error"}>{res.t}</Note>}
    </Card>
  );
}

// ---------- 2. Team ----------
function TeamStep({ s, setS }: { s: SetupData; setS: (s: SetupData) => void }) {
  const team = s.team.length ? s.team : [];
  const set = (i: number, m: Partial<Member>) => setS({ ...s, team: team.map((x, j) => (j === i ? { ...x, ...m } : x)) });
  const add = () => setS({ ...s, team: [...team, { id: "", name: "", github: "", os: "windows", agent: "claude", roles: "" }] });
  useEffect(() => {
    if (!team.length) setS({ ...s, team: [{ id: "", name: "", github: "", os: "mac", agent: "claude", roles: "" }] });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Card className="space-y-5">
      <Head title="Who's on the team?" sub="Each person's computer runs their own coding agent overnight, on their own subscription." />
      <div className="space-y-3">
        {team.map((m, i) => (
          <div key={i} className="rounded-md bg-[#0e0e0e] p-4 border border-night-700">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-night-600 text-xs font-medium text-cream">{initials(m.name || "?")}</span>
              <Input placeholder="Name" value={m.name} onChange={(e) => set(i, { name: e.target.value })} className="flex-1" />
              <Input placeholder="GitHub username" value={m.github} onChange={(e) => set(i, { github: e.target.value.replace(/^@/, "") })} className="w-40 sm:w-48" />
              <button onClick={() => setS({ ...s, team: team.filter((_, j) => j !== i) })} className="px-1 text-neutral-500 hover:text-red-300" title="Remove">
                ✕
              </button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Segmented<OS> value={m.os} onChange={(v) => set(i, { os: v })} options={[["mac", "Mac"], ["windows", "Windows"], ["linux", "Linux"]]} />
              <Segmented<Agent> value={m.agent} onChange={(v) => set(i, { agent: v })} options={[["claude", "Claude Code"], ["codex", "Codex"]]} />
              <Input placeholder="Role, e.g. frontend" value={m.roles} onChange={(e) => set(i, { roles: e.target.value })} className="min-w-40 flex-1" />
            </div>
            {!m.roles && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {ROLE_IDEAS.map((r) => (
                  <button key={r} onClick={() => set(i, { roles: r })} className="rounded-sm border border-night-600 px-2 py-0.5 text-xs text-neutral-400 hover:border-cream/50 hover:text-cream">
                    {r}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <Button kind="soft" onClick={add} disabled={team.length >= 8}>
        + Add teammate
      </Button>
    </Card>
  );
}

// ---------- 3. Rules ----------
function RulesStep({ s, setS }: { s: SetupData; setS: (s: SetupData) => void }) {
  const r = (k: keyof SetupData["rules"], v: unknown) => setS({ ...s, rules: { ...s.rules, [k]: v } });
  return (
    <Card className="space-y-5">
      <Head title="Overnight rules" sub="Everyone will be asleep, so decide these now. Agents never ask anything during the night." />
      <div className="space-y-1">
        <Toggle on={s.rules.review} onChange={(v) => r("review", v)} label="A second agent reviews every change" hint="Recommended. Catches mistakes before they merge." />
        <Toggle on={s.rules.stealing} onChange={(v) => r("stealing", v)} label="Idle computers help other teammates' areas" hint="If someone's list runs dry, they pick up waiting work from others." />
      </div>
      <div className="rounded-md bg-[#0e0e0e] p-4 text-sm text-neutral-300 border border-night-700">
        Always on: agents post on the team board, merge finished work into a <b className="text-white">night branch</b> (never main), and write down every decision they make for you to review in the morning.
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Agents per computer" hint="2 is a good start">
          <Segmented value={String(s.rules.perComputer)} onChange={(v) => r("perComputer", Number(v))} options={[["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"]]} />
        </Field>
        <Field label="Usage cap per computer" hint="estimated, not billed on subscriptions">
          <Segmented value={String(s.rules.usageCap)} onChange={(v) => r("usageCap", Number(v))} options={[["10", "Light"], ["25", "Normal"], ["60", "Heavy"]]} />
        </Field>
      </div>
      <Field label="Who owns shared contracts?" hint="their agent applies API/data changes others ask for">
        <select value={s.rules.contractsOwner} onChange={(e) => r("contractsOwner", e.target.value)} className="w-full rounded-md bg-night-950 px-3.5 py-2.5 text-sm text-neutral-100 border border-night-600">
          <option value="">{s.team[0]?.name ? `${s.team[0].name} (default)` : "First teammate"}</option>
          {s.team.map((m) => (
            <option key={m.id || m.name} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="How do we check the project works?" hint="optional; the planner suggests one">
        <Input placeholder="e.g. npm test && npm run build" value={s.rules.check} onChange={(e) => r("check", e.target.value)} />
      </Field>
    </Card>
  );
}

// ---------- 4. Plan ----------
function PlanStep({ app, s }: { app: AppState; s: SetupData }) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [job, setJob] = useState<{ running: boolean; log: string[]; ok?: boolean; error?: string }>({ running: false, log: [] });
  const [open, setOpen] = useState<string | null>(null);
  const [asText, setAsText] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const lead = s.team.find((m) => m.id === app.me) ?? s.team[0];
  const lanes = useMemo(() => [...new Set(s.team.flatMap((m) => m.roles.split(/[,/]/).map((r) => r.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).filter(Boolean)))], [s.team]);
  const owner = (lane: string) => s.team.find((m) => m.roles.toLowerCase().replace(/[^a-z0-9,]+/g, "-").includes(lane))?.name ?? "";

  const load = () => api.tasks().then((t) => setTasks(t.tasks));
  useEffect(() => {
    void load();
    void api.planStatus().then(setJob);
  }, []);
  useEffect(() => {
    if (!job.running) return;
    const t = setInterval(async () => {
      const j = await api.planStatus();
      setJob(j);
      if (!j.running) void load();
    }, 2000);
    return () => clearInterval(t);
  }, [job.running]);

  const generate = async () => {
    setMsg(null);
    try {
      await api.plan(lead?.agent ?? "claude");
      setJob({ running: true, log: ["Starting the planner…"] });
    } catch (e) {
      setMsg({ ok: false, t: String((e as Error).message) });
    }
  };
  const saveTasks = async (next: Task[]) => {
    try {
      await api.saveTasks({ tasks: next });
      setTasks(next);
      setMsg({ ok: true, t: "Saved." });
    } catch (e) {
      setMsg({ ok: false, t: String((e as Error).message) });
    }
  };
  const update = (id: string, patch: Partial<Task>) => tasks && setTasks(tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  return (
    <Card className="space-y-5">
      <Head title="Tonight's plan" sub="An AI planner turns your answers into shared contracts and small tasks for each teammate. Read it over: this is what gets built." />
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={generate} busy={job.running}>
          {tasks?.length ? "Regenerate plan" : "Generate the plan"}
        </Button>
        <span className="text-xs text-neutral-500">Uses {lead?.name ? `${lead.name}'s` : "your"} {agentLabel(lead?.agent)} subscription. Takes a few minutes.</span>
        {tasks && tasks.length > 0 && (
          <button onClick={async () => setAsText(asText === null ? (await api.tasks()).yaml : null)} className="ml-auto text-xs text-neutral-400 hover:text-neutral-200">
            {asText === null ? "Edit as text" : "Back to cards"}
          </button>
        )}
      </div>
      {job.running && (
        <div className="max-h-40 overflow-auto rounded-md bg-night-950 p-3 font-mono text-xs text-neutral-400">
          {job.log.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}
      {job.error && <Note kind="error">{job.error}</Note>}
      {msg && <Note kind={msg.ok ? "ok" : "error"}>{msg.t}</Note>}

      {asText !== null ? (
        <div className="space-y-2">
          <Text rows={18} spellCheck={false} className="font-mono text-xs" value={asText} onChange={(e) => setAsText(e.target.value)} />
          <Button
            onClick={async () => {
              try {
                await api.saveTasks({ yaml: asText });
                setAsText(null);
                await load();
                setMsg({ ok: true, t: "Saved." });
              } catch (e) {
                setMsg({ ok: false, t: String((e as Error).message) });
              }
            }}
          >
            Save
          </Button>
        </div>
      ) : (
        tasks &&
        tasks.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2">
            {[...new Set([...lanes, ...tasks.map((t) => t.lane)])].map((lane) => (
              <div key={lane}>
                <div className="mb-2 flex items-baseline gap-2">
                  <span className="font-light capitalize text-cream">{lane.replace(/-/g, " ")}</span>
                  <span className="text-xs text-neutral-500">{owner(lane)}</span>
                </div>
                <div className="space-y-1.5">
                  {tasks
                    .filter((t) => t.lane === lane)
                    .map((t) => (
                      <div key={t.id} className="rounded-md bg-[#0e0e0e] border border-night-700">
                        <button onClick={() => setOpen(open === t.id ? null : t.id)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
                          <span className="text-[11px] font-semibold text-neutral-500">{t.id}</span>
                          <span className="flex-1 text-sm text-neutral-200">{t.title}</span>
                          {t.depends_on?.length ? <span className="text-[11px] text-neutral-600">after {t.depends_on.join(", ")}</span> : null}
                        </button>
                        {open === t.id && (
                          <div className="space-y-2 border-t border-night-700 p-3">
                            <Input value={t.title} onChange={(e) => update(t.id, { title: e.target.value })} />
                            <Text rows={5} value={t.brief ?? ""} onChange={(e) => update(t.id, { brief: e.target.value })} />
                            <div className="text-[11px] text-neutral-500">Can change: {t.lease.join(", ")}</div>
                            <div className="flex gap-2">
                              <Button kind="soft" onClick={() => saveTasks(tasks)}>
                                Save
                              </Button>
                              <Button kind="ghost" onClick={() => saveTasks(tasks.filter((x) => x.id !== t.id && true).map((x) => ({ ...x, depends_on: (x.depends_on ?? []).filter((d) => d !== t.id) })))}>
                                Delete task
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                </div>
              </div>
            ))}
          </div>
        )
      )}
      {tasks && !tasks.length && !job.running && <p className="text-sm text-neutral-500">No tasks yet. Generate the plan, or use "Edit as text" after generating to write your own.</p>}
    </Card>
  );
}

// ---------- 5. Share ----------
function ShareStep({ app, s, reload }: { app: AppState; s: SetupData; reload: () => Promise<AppState | null> }) {
  const [pre, setPre] = useState<{ files: string[]; repo: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ ok: boolean; t: string } | null>(null);
  const [invites, setInvites] = useState<Record<string, string>>({});
  useEffect(() => void api.sharePreview().then(setPre).catch(() => {}), []);
  const repoLink = pre?.repo ? `https://github.com/${pre.repo}` : app.board?.repo ? `https://github.com/${app.board.repo}` : "";
  const share = async () => {
    setBusy(true);
    try {
      const r = await api.share();
      setRes({ ok: true, t: r.steps.join("\n") });
      await reload();
      setPre(await api.sharePreview());
    } catch (e) {
      setRes({ ok: false, t: String((e as Error).message) });
    }
    setBusy(false);
  };
  const message = `Join our Nightshift team for ${s.event.name || "the hackathon"}:
1. Install Node.js 20+, Git, and the GitHub CLI, then sign in: gh auth login
2. Install your agent and sign in with your subscription:
   Claude Code: npm install -g @anthropic-ai/claude-code   then run: claude   and type /login
   Codex:       npm install -g @openai/codex   then: codex login
3. Get Nightshift:  git clone ${NIGHTSHIFT_REPO} && cd nightshift && npm install && npm start
4. In the page that opens, click "Join my team" and paste: ${repoLink || "<project link>"}`;
  return (
    <Card className="space-y-5">
      <Head title="Share with the team" sub="This saves the plan to GitHub and creates the team's message board, where agents talk overnight." />
      {pre && pre.files.length > 0 && <div className="text-sm text-neutral-400">{pre.files.length} new or changed file{pre.files.length === 1 ? "" : "s"} will be pushed to {pre.repo ?? "GitHub"}.</div>}
      <Button onClick={share} busy={busy}>
        {app.board?.issue ? "Push the latest plan" : "Share the plan"}
      </Button>
      {res && <Note kind={res.ok ? "ok" : "error"}>{res.t}</Note>}
      {app.board?.issue && repoLink && (
        <p className="text-sm text-neutral-400">
          Team board:{" "}
          <a className="text-indigo-300 hover:underline" href={`${repoLink}/issues/${app.board.issue}`} target="_blank" rel="noreferrer">
            issue #{app.board.issue}
          </a>
        </p>
      )}
      <div className="space-y-2 border-t border-night-700 pt-5">
        <div className="text-sm font-medium text-white">Give teammates access</div>
        {s.team
          .filter((m) => m.github)
          .map((m) => (
            <div key={m.id} className="flex items-center gap-3 text-sm">
              <span className="w-32 truncate text-neutral-200">{m.name}</span>
              <span className="flex-1 text-neutral-500">@{m.github}</span>
              {invites[m.id] ? (
                <span className="text-xs text-copper">{invites[m.id]}</span>
              ) : (
                <Button
                  kind="soft"
                  onClick={async () => {
                    try {
                      const r = await api.invite(m.github);
                      setInvites({ ...invites, [m.id]: r.note });
                    } catch (e) {
                      setInvites({ ...invites, [m.id]: String((e as Error).message) });
                    }
                  }}
                >
                  Invite
                </Button>
              )}
            </div>
          ))}
        {!s.team.some((m) => m.github) && <p className="text-sm text-neutral-500">Add GitHub usernames in the Team step to invite people from here.</p>}
      </div>
      <div className="space-y-2 border-t border-night-700 pt-5">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-white">Send this to your teammates</span>
          <Copy text={message} label="Copy message" />
        </div>
        <pre className="whitespace-pre-wrap rounded-md bg-night-950 p-4 text-xs leading-relaxed text-neutral-300">{message}</pre>
      </div>
    </Card>
  );
}

// ---------- 6. Your computer ----------
const INSTALL: Record<OS, Record<string, string>> = {
  mac: {
    node: "brew install node   (or download from nodejs.org)",
    git: "xcode-select --install",
    gh: "brew install gh && gh auth login",
    claude: "npm install -g @anthropic-ai/claude-code   then run: claude   and type /login",
    codex: "npm install -g @openai/codex && codex login",
  },
  windows: {
    node: "winget install OpenJS.NodeJS.LTS",
    git: "winget install Git.Git   (includes Git Bash, which Nightshift uses for checks)",
    gh: "winget install GitHub.cli   then: gh auth login",
    claude: "npm install -g @anthropic-ai/claude-code   then run: claude   and type /login",
    codex: "npm install -g @openai/codex   then: codex login",
  },
  linux: {
    node: "Install Node.js 20+ from nodejs.org or your package manager",
    git: "sudo apt install git",
    gh: "See cli.github.com, then: gh auth login",
    claude: "npm install -g @anthropic-ai/claude-code   then run: claude   and type /login",
    codex: "npm install -g @openai/codex && codex login",
  },
};

function ComputerStep({ app, s, reload }: { app: AppState; s: SetupData; reload: () => Promise<AppState | null> }) {
  const [tools, setTools] = useState<Tools | null>(null);
  const [checks, setChecks] = useState<{ checks: Check[]; ok: boolean; posted: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const me = s.team.find((m) => m.id === app.me);
  useEffect(() => void api.tools().then(setTools), []);
  const os = tools?.os ?? "mac";
  const agent = me?.agent ?? "claude";
  const items = tools
    ? [
        { k: "git", ok: tools.git && tools.bash, label: os === "windows" ? "Git + Git Bash" : "Git" },
        { k: "gh", ok: !!tools.ghLogin, label: tools.ghLogin ? `GitHub CLI (signed in as ${tools.ghLogin})` : "GitHub CLI, signed in" },
        agent === "codex"
          ? { k: "codex", ok: tools.codex.installed && tools.codex.loggedIn && tools.codex.subscription, label: "Codex, signed in with ChatGPT" }
          : { k: "claude", ok: tools.claude.installed && tools.claude.loggedIn && tools.claude.subscription, label: "Claude Code, signed in with your Claude plan" },
      ]
    : [];
  const ghMismatch = tools?.ghLogin && me?.github && tools.ghLogin.toLowerCase() !== me.github.toLowerCase();

  return (
    <Card className="space-y-5">
      <Head title="Set up this computer" sub="Each teammate does this on their own computer before bed." />
      <Field label="Which teammate are you?">
        <div className="flex flex-wrap gap-2">
          {s.team.map((m) => (
            <button
              key={m.id}
              onClick={async () => {
                await api.setMe(m.id);
                await reload();
              }}
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm ring-1 transition ${app.me === m.id ? "bg-cream text-night-950 border-cream" : "bg-[#0e0e0e] text-neutral-300 ring-white/5 hover:ring-white/20"}`}
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-night-800 text-[10px] font-semibold">{initials(m.name)}</span>
              {m.name}
            </button>
          ))}
        </div>
      </Field>
      {me && (
        <>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-white">What this computer needs</span>
              <button onClick={async () => setTools(await api.tools(true))} className="text-xs text-neutral-400 hover:text-neutral-200">
                Check again
              </button>
            </div>
            {!tools && <div className="text-sm text-neutral-500">Checking…</div>}
            {items.map((it) => (
              <div key={it.k} className="rounded-md bg-[#0e0e0e] p-3 border border-night-700">
                <div className="flex items-center gap-2 text-sm">
                  <span className={it.ok ? "text-copper" : "text-amber-300"}>{it.ok ? "✓" : "○"}</span>
                  <span className="text-neutral-200">{it.label}</span>
                </div>
                {!it.ok && <div className="mt-2"><Code>{INSTALL[os][it.k]}</Code></div>}
              </div>
            ))}
            {ghMismatch && <Note kind="warn">GitHub CLI is signed in as {tools!.ghLogin}, but the team list says {me.github}. Sign in as yourself (gh auth login) so the agents can see each other.</Note>}
            {me.os !== os && <Note kind="warn">The team list says {me.name} uses {me.os}, but this computer is {os}. That's fine. Update it in the Team step if you like.</Note>}
          </div>
          <div className="space-y-3 border-t border-night-700 pt-5">
            <div className="text-sm text-neutral-400">The final check catches anything that would stop the night at 3 a.m.: power, sleep, GitHub access, and a real test call to your agent.</div>
            <Button
              busy={busy}
              onClick={async () => {
                setBusy(true);
                setErr("");
                try {
                  setChecks(await api.preflight(true));
                } catch (e) {
                  setErr(String((e as Error).message));
                }
                setBusy(false);
              }}
            >
              Run the final check
            </Button>
            {err && <Note kind="error">{err}</Note>}
            {checks && (
              <div className="space-y-1.5">
                {checks.checks
                  .filter((c) => c.status !== "pass" || /login|live|power|push|board/i.test(c.name))
                  .map((c) => (
                    <div key={c.name} className="flex gap-2 text-sm">
                      <span className={c.status === "pass" ? "text-copper" : c.status === "warn" ? "text-amber-300" : "text-red-400"}>{c.status === "pass" ? "✓" : c.status === "warn" ? "!" : "✕"}</span>
                      <span>
                        <span className="text-neutral-200">{c.name}</span> <span className="text-neutral-500">· {c.detail}</span>
                      </span>
                    </div>
                  ))}
                <Note kind={checks.ok ? "ok" : "error"}>{checks.ok ? `This computer is ready.${checks.posted ? " Your team can see that on the board." : ""}` : "Fix the ✕ items above, then run the check again."}</Note>
              </div>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

// ---------- 7. Start ----------
function StartStep({ app, reload, goTonight }: { app: AppState; reload: () => Promise<AppState | null>; goTonight: () => void }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    const load = () => api.snapshot().then(setSnap).catch((e) => setErr(String(e.message)));
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  const ready = new Set((snap?.board ?? []).filter((m) => m.env?.type === "ready").map((m) => m.env!.from));
  // Latest node_up / node_down per teammate decides "running" vs "finished".
  const lastLife = new Map<string, string>();
  for (const m of snap?.board ?? []) if (m.env && (m.env.type === "node_up" || m.env.type === "node_down")) lastLife.set(m.env.from, m.env.type);
  const up = new Set([...lastLife].filter(([, t]) => t === "node_up").map(([id]) => id));
  const finished = new Set([...lastLife].filter(([, t]) => t === "node_down").map(([id]) => id));
  const isLead = app.setup?.team[0]?.id === app.me;
  const start = async (everyone: boolean) => {
    setBusy(true);
    try {
      await api.start(everyone);
      await reload();
      goTonight();
    } catch (e) {
      setErr(String((e as Error).message));
    }
    setBusy(false);
  };
  return (
    <Card className="space-y-6">
      <Head title="Start the night" sub="Leave your computer plugged in with the lid open. Nobody will be asked anything until morning." />
      <div className="grid gap-2 sm:grid-cols-2">
        {(snap?.nodes ?? []).map((n) => (
          <div key={n.id} className="flex items-center gap-3 rounded-md bg-[#0e0e0e] px-3 py-2.5 border border-night-700">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-night-800 text-xs font-semibold">{initials(n.name)}</span>
            <span className="flex-1 text-sm text-neutral-200">
              {n.name} <span className="text-neutral-500">· {agentLabel(n.agent)}</span>
            </span>
            <span className={`text-xs ${up.has(n.id) ? "text-indigo-300" : finished.has(n.id) || ready.has(n.id) ? "text-copper" : "text-neutral-500"}`}>{up.has(n.id) ? "running" : finished.has(n.id) ? "finished" : ready.has(n.id) ? "ready" : "not checked yet"}</span>
          </div>
        ))}
      </div>
      {err && <Note kind="error">{err}</Note>}
      {app.running ? (
        <Button onClick={goTonight}>Watch tonight →</Button>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {isLead && (
              <Button busy={busy} onClick={() => start(true)}>
                Start the night for everyone
              </Button>
            )}
            <Button kind={isLead ? "soft" : "primary"} busy={busy} onClick={() => start(false)}>
              Start on this computer
            </Button>
          </div>
          <Toggle
            on={app.autoStart}
            onChange={async (v) => {
              await api.autostart(v);
              await reload();
            }}
            label="Start automatically when the lead starts the night"
            hint="Keep this page open. Your computer joins as soon as the 'start for everyone' message arrives."
          />
        </div>
      )}
    </Card>
  );
}

function Head({ title, sub }: { title: string; sub: string }) {
  const tag: Record<string, string> = {
    "Tell us about the hackathon": "Step 1 · Hackathon",
    "Who's on the team?": "Step 2 · Team",
    "Overnight rules": "Step 3 · Rules",
    "Tonight's plan": "Step 4 · Plan",
    "Share with the team": "Step 5 · Share",
    "Set up this computer": "Step 6 · Your computer",
    "Start the night": "Step 7 · Start",
  };
  return <Title tag={tag[title]} title={title} sub={sub} />;
}
