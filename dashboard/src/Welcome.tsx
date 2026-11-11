import { useState } from "react";
import { api, AppState } from "./api";
import { Button, Card, Field, Input, Moon, Note } from "./ui";

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
    <div className="mx-auto max-w-3xl px-4 py-12 sm:py-20">
      <div className="mb-10 text-center">
        <Moon className="mx-auto h-10 w-10 text-amber-300" />
        <h1 className="mt-4 text-3xl font-semibold tracking-tight text-white">Nightshift</h1>
        <p className="mx-auto mt-2 max-w-md text-slate-400">Plan together in the evening. Your team's AI agents build overnight. Review one pull request in the morning.</p>
      </div>

      {!mode && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Choice title="Start a new team" body="For the team lead: describe the hackathon, add teammates, and generate the plan." onClick={() => setMode("new")} />
          <Choice title="Join my team" body="Your lead sent you a GitHub link. Paste it and you're in." onClick={() => setMode("join")} />
          <Choice title="Open a project folder" body="A repo you already have on this computer." onClick={() => setMode("open")} small />
          <Choice title="Watch a practice night" body="Four pretend teammates build a project in about two minutes. Uses no AI." onClick={() => act(() => api.practice(), "tonight")} small />
        </div>
      )}

      {mode && (
        <Card className="mx-auto max-w-xl">
          <button onClick={() => setMode(null)} className="mb-4 text-sm text-slate-400 hover:text-slate-200">
            ← Back
          </button>
          {mode === "new" && (
            <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), act(() => api.create(f.name, f.parent, f.desc)))}>
              <h2 className="text-lg font-semibold text-white">Start a new team</h2>
              <p className="text-sm text-slate-400">Nightshift creates a private GitHub repo for the project and a folder on this computer.</p>
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
              <p className="text-xs text-slate-500">Already made the repo? Use "Open a project folder" or "Join my team" with its link.</p>
            </form>
          )}
          {mode === "join" && (
            <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), act(() => api.clone(f.url, f.parent)))}>
              <h2 className="text-lg font-semibold text-white">Join my team</h2>
              <Field label="GitHub link from your team lead">
                <Input autoFocus required placeholder="https://github.com/owner/project" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />
              </Field>
              <Field label="Folder on this computer">
                <Input value={f.parent} onChange={(e) => setF({ ...f, parent: e.target.value })} />
              </Field>
              <Button type="submit" busy={busy} className="w-full">
                Join
              </Button>
              <p className="text-xs text-slate-500">Accept the GitHub invitation from your lead first (check your email or github.com/notifications).</p>
            </form>
          )}
          {mode === "open" && (
            <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), act(() => api.open(f.path)))}>
              <h2 className="text-lg font-semibold text-white">Open a project folder</h2>
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

      {!mode && err && <div className="mt-4"><Note kind="error">{err}</Note></div>}

      {!mode && app.recent.length > 0 && (
        <div className="mt-10">
          <div className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">Recent</div>
          <div className="space-y-1">
            {app.recent.map((p) => (
              <button key={p} onClick={() => act(() => api.open(p))} className="block w-full truncate rounded-lg px-3 py-2 text-left text-sm text-slate-300 hover:bg-white/5">
                {p}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Choice({ title, body, onClick, small }: { title: string; body: string; onClick: () => void; small?: boolean }) {
  return (
    <button onClick={onClick} className={`rounded-2xl bg-night-900 p-5 text-left ring-1 ring-white/5 transition hover:bg-night-850 hover:ring-indigo-400/40 ${small ? "" : "sm:p-6"}`}>
      <div className={`font-semibold text-white ${small ? "" : "text-lg"}`}>{title}</div>
      <div className="mt-1 text-sm text-slate-400">{body}</div>
    </button>
  );
}
