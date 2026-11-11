import { useState } from "react";
import { api, AppState } from "./api";
import { Button, Card, Field, Input, Moon, Note, Rays, Tag } from "./ui";

type Mode = null | "new" | "join" | "open";

export function Welcome({ app, onOpened }: { app: AppState; onOpened: (tab?: "setup" | "tonight") => void }) {
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const parent = `${app.home}${app.sep}hackathons`;
  const [f, setF] = useState({ name: "", desc: "", url: "", parent, path: "" });

  const act = async (fn: () => Promise<unknown>, tab?: "setup" | "tonight") => {
    setBusy(true);
    setErr("");
    try {
      await fn();
      onOpened(tab);
    } catch (e) {
      setErr(String((e as Error).message));
    }
    setBusy(false);
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-night-700">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-5 py-4 sm:px-8">
          <Moon className="h-5 w-5 text-cream" />
          <span className="font-semibold text-cream">Nightshift</span>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => act(() => api.practice(), "tonight")} className="hidden px-3 text-[13px] text-neutral-300 hover:text-white sm:block">
              Practice night
            </button>
            <Button kind="soft" onClick={() => setMode("join")}>
              Join my team
            </Button>
            <Button onClick={() => setMode("new")}>Start a new team</Button>
          </div>
        </div>
      </header>

      {!mode && (
        <>
          <section className="mx-auto grid max-w-6xl gap-10 px-5 pb-10 pt-14 sm:px-8 sm:pt-24 lg:grid-cols-[1.1fr_1fr]">
            <div>
              <Tag>Overnight builds for hackathon teams</Tag>
              <h1 className="mt-5 text-5xl font-light leading-[1.05] text-cream sm:text-6xl">
                Plan together tonight. Wake up to a working build.
              </h1>
              <p className="mt-5 max-w-lg text-[15px] leading-relaxed text-neutral-400">
                Every teammate's own Claude Code or Codex works through the night on their Mac or Windows laptop. Agents split the work, hand pieces to each other, review each other, and merge. Nobody has to stay awake.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Button onClick={() => setMode("new")}>Start a new team</Button>
                <Button kind="soft" onClick={() => setMode("join")}>
                  Join my team
                </Button>
              </div>
            </div>
            <HeroArt />
          </section>

          <section className="relative mx-auto max-w-6xl px-5 sm:px-8">
            <div className="grid border-t border-night-700 sm:grid-cols-3">
              {[
                ["01", "Describe it", "Event, idea, team, rules. A planner turns it into contracts and small tasks for each person."],
                ["02", "Sleep", "Each computer's agent builds its tasks, asks teammates' agents when stuck, and never waits for a human."],
                ["03", "Review", "One report with every decision the agents made, and one pull request into main."],
              ].map(([n, t, b], i) => (
                <div key={n} className={`py-8 sm:px-6 ${i ? "sm:border-l sm:border-night-700" : "sm:pl-0"}`}>
                  <div className="font-mono text-xs text-neutral-500">{n}</div>
                  <div className="mt-6 text-lg font-light text-cream">{t}</div>
                  <p className="mt-2 text-sm leading-relaxed text-neutral-400">{b}</p>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-2 border-t border-night-700 py-6 text-sm">
              <button onClick={() => setMode("open")} className="text-neutral-300 hover:text-white">
                Open a project folder →
              </button>
              <button onClick={() => act(() => api.practice(), "tonight")} className="text-neutral-300 hover:text-white">
                Watch a practice night (no AI used) →
              </button>
            </div>
          </section>
        </>
      )}

      {mode && (
        <Card className="mx-auto mt-14 max-w-xl">
          <button onClick={() => setMode(null)} className="mb-4 text-sm text-neutral-400 hover:text-neutral-200">
            ← Back
          </button>
          {mode === "new" && (
            <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), act(() => api.create(f.name, f.parent, f.desc)))}>
              <h2 className="text-2xl font-light text-cream">Start a new team</h2>
              <p className="text-sm text-neutral-400">Nightshift creates a private GitHub repo for the project and a folder on this computer.</p>
              <Field label="Project name" hint="becomes the repo name">
                <Input autoFocus required placeholder="e.g. shiftsync" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value.replace(/\s+/g, "-") })} />
              </Field>
              <Field label="One-line description" hint="optional">
                <Input placeholder="What are you building?" value={f.desc} onChange={(e) => setF({ ...f, desc: e.target.value })} />
              </Field>
              <Field label="Folder on this computer">
                <Input value={f.parent} onChange={(e) => setF({ ...f, parent: e.target.value })} />
              </Field>
              <Button type="submit" busy={busy} className="w-full">
                Create project
              </Button>
              <p className="text-xs text-neutral-500">Already made the repo? Use "Open a project folder" or "Join my team" with its link.</p>
            </form>
          )}
          {mode === "join" && (
            <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), act(() => api.clone(f.url, f.parent)))}>
              <h2 className="text-2xl font-light text-cream">Join my team</h2>
              <Field label="GitHub link from your team lead">
                <Input autoFocus required placeholder="https://github.com/owner/project" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />
              </Field>
              <Field label="Folder on this computer">
                <Input value={f.parent} onChange={(e) => setF({ ...f, parent: e.target.value })} />
              </Field>
              <Button type="submit" busy={busy} className="w-full">
                Join
              </Button>
              <p className="text-xs text-neutral-500">Accept the GitHub invitation from your lead first (check your email or github.com/notifications).</p>
            </form>
          )}
          {mode === "open" && (
            <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), act(() => api.open(f.path)))}>
              <h2 className="text-2xl font-light text-cream">Open a project folder</h2>
              <Field label="Folder path">
                <Input autoFocus required placeholder={`${parent}${app.sep}my-project`} value={f.path} onChange={(e) => setF({ ...f, path: e.target.value })} />
              </Field>
              <Button type="submit" busy={busy} className="w-full">
                Open
              </Button>
            </form>
          )}
          {err && <div className="mt-4"><Note kind="error">{err}</Note></div>}
        </Card>
      )}

      {!mode && err && <div className="mx-auto max-w-6xl px-5 sm:px-8"><Note kind="error">{err}</Note></div>}

      {!mode && app.recent.length > 0 && (
        <div className="mx-auto max-w-6xl px-5 pb-16 sm:px-8">
          <div className="mb-2 text-xs font-medium uppercase tracking-wider text-neutral-500">Recent</div>
          <div className="space-y-1">
            {app.recent.map((p) => (
              <button key={p} onClick={() => act(() => api.open(p))} className="block w-full truncate rounded-lg px-3 py-2 text-left text-sm text-neutral-300 hover:bg-white/5">
                {p}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** A still version of the Tonight map on a copper grid. */
function HeroArt() {
  const people = [
    { x: 200, y: 52, n: "EM" },
    { x: 330, y: 160, n: "DL" },
    { x: 200, y: 268, n: "AB" },
    { x: 70, y: 160, n: "AT" },
  ];
  return (
    <div className="relative overflow-hidden rounded-md border border-night-700 bg-[#141414]">
      <div className="copper-grid absolute inset-0" />
      <Rays className="absolute bottom-0 left-0 h-1/2 w-2/3 opacity-60" />
      <svg viewBox="0 0 400 320" className="relative block w-full">
        {people.map((p) => (
          <line key={p.n} x1={p.x} y1={p.y} x2="200" y2="160" stroke="#ecebe4" strokeOpacity="0.12" />
        ))}
        <path d="M70,160 Q120,70 200,52" fill="none" stroke="#d98b45" strokeWidth="1.5" strokeDasharray="5 5" className="dash-flow" />
        <path d="M330,160 Q290,250 200,268" fill="none" stroke="#9ec5e8" strokeWidth="1.5" strokeDasharray="5 5" className="dash-flow" />
        <circle cx="200" cy="160" r="26" fill="#1c1c1c" stroke="#d98b45" />
        <path transform="translate(190 148) scale(0.62)" d="M20 4a12 12 0 1 0 8 20A10 10 0 0 1 20 4z" fill="#ecebe4" />
        {people.map((p) => (
          <g key={p.n}>
            <circle cx={p.x} cy={p.y} r="22" fill="#171717" stroke="#ecebe4" strokeOpacity="0.5" />
            <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize="11" fill="#ecebe4">
              {p.n}
            </text>
          </g>
        ))}
      </svg>
      <div className="relative flex justify-between border-t border-night-700 px-4 py-2.5 font-mono text-[11px] text-neutral-500">
        <span>night/2026-11-11</span>
        <span>11 / 13 merged</span>
      </div>
    </div>
  );
}
