import { useEffect, useState } from "react";
import { api, Snapshot, CheckResult } from "./api";
import { H } from "./NightView";

type File = "idea" | "night" | "tasks";
const LABEL: Record<File, string> = { idea: "idea.md", night: "night.yaml", tasks: "tasks.yaml" };

export function PlanView({ snap }: { snap: Snapshot | null }) {
  const [files, setFiles] = useState<Record<File, string> | null>(null);
  const [orig, setOrig] = useState<Record<File, string> | null>(null);
  const [active, setActive] = useState<File>("tasks");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [live, setLive] = useState(true);
  const running = !!snap && (snap.live || !!snap.daemonPid) && !snap.finished && !snap.stopped;

  useEffect(() => {
    api.plan().then((p) => {
      setFiles(p);
      setOrig(p);
    });
  }, []);

  const dirty = files && orig && (Object.keys(files) as File[]).some((k) => files[k] !== orig[k]);
  const save = async () => {
    if (!files) return;
    try {
      const r = await api.savePlan(files);
      setOrig(files);
      setMsg({ ok: true, text: r.note });
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error).message) });
    }
  };
  const runPreflight = async () => {
    setChecking(true);
    setChecks(null);
    try {
      setChecks(await api.preflight(live));
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error).message) });
    }
    setChecking(false);
  };
  const ready = !!checks && !checks.some((c) => c.status === "fail") && !dirty;
  const start = async () => {
    if (!confirm("Start the night on this Mac? From here on nothing will ask you anything. Leave the Mac plugged in with the lid open.")) return;
    try {
      await api.start();
      setMsg({ ok: true, text: "Node starting. Switch to the Night tab. Good night." });
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error).message) });
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <section>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {(Object.keys(LABEL) as File[]).map((f) => (
            <button key={f} onClick={() => setActive(f)} className={`rounded-md px-3 py-1.5 font-mono text-sm ${active === f ? "bg-night-700 text-white" : "bg-night-900 text-slate-400 hover:text-slate-200"}`}>
              {LABEL[f]}
              {files && orig && files[f] !== orig[f] && <span className="ml-1 text-amber-300">•</span>}
            </button>
          ))}
          <button disabled={!dirty || running} onClick={save} className="ml-auto rounded-md bg-amber-300 px-4 py-1.5 text-sm font-medium text-night-950 disabled:opacity-40">
            Validate & save
          </button>
        </div>
        {msg && <div className={`mb-3 whitespace-pre-wrap rounded-lg border p-3 text-sm ${msg.ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-red-500/40 bg-red-500/10 text-red-200"}`}>{msg.text}</div>}
        <textarea
          spellCheck={false}
          disabled={!files || running}
          value={files?.[active] ?? "Loading…"}
          onChange={(e) => files && setFiles({ ...files, [active]: e.target.value })}
          className="scroll-thin h-[70vh] w-full resize-none rounded-xl border border-night-700 bg-night-900 p-4 font-mono text-[13px] leading-relaxed text-slate-200 outline-none focus:border-amber-300/50"
        />
        <p className="mt-2 text-xs text-slate-500">
          Saving writes to <code>.nightshift/</code> in this checkout. Commit and push it so all four nodes run the same plan. Run <code>nightshift plan</code> in a terminal to have the planner write contracts and tasks from idea.md.
        </p>
      </section>

      <aside className="space-y-4">
        <div className="rounded-xl border border-night-700 bg-night-900 p-4">
          <H>Before bed</H>
          <ol className="space-y-1.5 text-sm text-slate-300">
            <li>1. Write the idea; plan; review tasks and leases together.</li>
            <li>2. Set every <code className="text-amber-200">authorize</code> flag in night.yaml.</li>
            <li>3. Commit & push <code>.nightshift/</code>.</li>
            <li>4. Each teammate runs preflight on their own Mac.</li>
            <li>5. Start the night. Plug in, lid open, sleep.</li>
          </ol>
        </div>
        <div className="rounded-xl border border-night-700 bg-night-900 p-4">
          <div className="flex items-center justify-between">
            <H>Preflight · {snap?.node.name ?? "this Mac"}</H>
          </div>
          <label className="mb-3 flex items-center gap-2 text-xs text-slate-400">
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> include a live model call (about a cent)
          </label>
          <button onClick={runPreflight} disabled={checking} className="w-full rounded-md border border-night-600 py-2 text-sm text-slate-200 hover:bg-night-800 disabled:opacity-50">
            {checking ? "Checking…" : "Run preflight"}
          </button>
          {checks && (
            <ul className="mt-3 space-y-1.5 text-sm">
              {checks.map((c) => (
                <li key={c.name} className="flex gap-2">
                  <span className={c.status === "pass" ? "text-emerald-400" : c.status === "warn" ? "text-amber-300" : "text-red-400"}>{c.status === "pass" ? "✔" : c.status === "warn" ? "!" : "✖"}</span>
                  <span>
                    <span className="text-slate-200">{c.name}</span>
                    <span className="block text-xs text-slate-500">{c.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <button onClick={start} disabled={!ready || running} className="mt-4 w-full rounded-lg bg-indigo-500 py-2.5 font-medium text-white shadow-lg shadow-indigo-500/20 transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:bg-night-700 disabled:text-slate-500 disabled:shadow-none">
            {running ? "Night is running" : "Start night on this Mac"}
          </button>
          {!ready && !running && <p className="mt-2 text-xs text-slate-500">Enabled after a preflight with no ✖ and no unsaved edits.</p>}
        </div>
      </aside>
    </div>
  );
}
