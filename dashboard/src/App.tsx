import { useEffect, useMemo, useState } from "react";
import { api, Snapshot, LedgerEvent } from "./api";
import { NightView } from "./NightView";
import { BoardView } from "./BoardView";
import { PlanView } from "./PlanView";
import { ReportView } from "./ReportView";
import { Moon } from "./ui";

type Tab = "night" | "board" | "plan" | "report";

export default function App() {
  const [tab, setTab] = useState<Tab>(() => (localStorage.getItem("ns-tab") as Tab) || "night");
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [err, setErr] = useState("");
  const [events, setEvents] = useState<LedgerEvent[]>([]);

  useEffect(() => {
    try {
      localStorage.setItem("ns-tab", tab);
    } catch {
      /* private mode */
    }
  }, [tab]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .snapshot()
        .then((s) => {
          if (!alive) return;
          setSnap(s);
          setErr("");
          setEvents((cur) => (cur.length ? cur : s.ledger));
        })
        .catch((e) => alive && setErr(String(e.message ?? e)));
    load();
    const t = setInterval(load, 3000);
    const es = new EventSource("/api/events");
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as LedgerEvent;
      if (e.kind === "ping") return;
      setEvents((cur) => [...cur.slice(-400), e]);
    };
    return () => {
      alive = false;
      clearInterval(t);
      es.close();
    };
  }, []);

  const teamSpent = useMemo(() => Object.values(snap?.spent ?? {}).reduce((a, b) => a + b, 0), [snap]);
  const running = !!snap && (snap.live || !!snap.daemonPid) && !snap.stopped && !snap.finished;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-night-700 bg-night-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <Moon className="h-6 w-6 text-amber-300" />
            <span className="text-lg font-semibold tracking-tight text-white">Nightshift</span>
            {snap && <span className="hidden text-sm text-slate-400 sm:inline">· {snap.project}</span>}
          </div>
          {snap && (
            <div className="flex items-center gap-2 text-sm">
              <code className="rounded bg-night-800 px-2 py-0.5 text-amber-200">{snap.branch}</code>
              <StatusPill snap={snap} running={running} />
            </div>
          )}
          <nav className="flex gap-1 rounded-lg bg-night-900 p-1 text-sm">
            {(["night", "board", "plan", "report"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-md px-3.5 py-1.5 capitalize transition ${tab === t ? "bg-night-700 text-white shadow" : "text-slate-400 hover:text-slate-200"}`}
              >
                {t}
              </button>
            ))}
          </nav>
          {snap && (
            <div className="ml-auto flex items-center gap-4">
              <Spend label="team" spent={teamSpent} cap={snap.budget.team_usd} />
              {running && <StopButtons />}
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-[1500px] px-4 py-6 sm:px-6">
        {err && !snap && <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-red-200">Cannot reach the Nightshift server: {err}</div>}
        {snap && tab === "night" && <NightView snap={snap} events={events} />}
        {snap && tab === "board" && <BoardView snap={snap} />}
        {tab === "plan" && <PlanView snap={snap} />}
        {tab === "report" && <ReportView />}
      </main>
    </div>
  );
}

function StatusPill({ snap, running }: { snap: Snapshot; running: boolean }) {
  if (snap.finished) return <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-emerald-300">night finished</span>;
  if (snap.stopped) return <span className="rounded-full bg-red-500/15 px-2.5 py-0.5 text-red-300">stopped: {snap.stopReason}</span>;
  if (running)
    return (
      <span className="flex items-center gap-1.5 rounded-full bg-indigo-500/15 px-2.5 py-0.5 text-indigo-200">
        <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-indigo-300" /> running · {snap.node.name}'s node{snap.adapter === "fake" ? " · rehearsal" : ""}
      </span>
    );
  return <span className="rounded-full bg-night-800 px-2.5 py-0.5 text-slate-400">not running on this Mac</span>;
}

function Spend({ label, spent, cap }: { label: string; spent: number; cap: number }) {
  const pct = Math.min(100, (spent / cap) * 100);
  return (
    <div className="hidden w-40 md:block" title={`${label} spend $${spent.toFixed(2)} of $${cap}`}>
      <div className="flex justify-between text-xs text-slate-400">
        <span>{label} spend</span>
        <span className="tabular-nums">
          ${spent.toFixed(2)} / ${cap}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-night-800">
        <div className={`h-full rounded-full ${pct > 85 ? "bg-red-400" : "bg-amber-300"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function StopButtons() {
  const [busy, setBusy] = useState(false);
  const stop = async (team: boolean) => {
    if (!confirm(team ? "Stop every node on the team? Running agents are aborted; their tasks can be taken over when you start again." : "Stop this Mac's node?")) return;
    setBusy(true);
    await api.stop(team).catch(() => {});
    setBusy(false);
  };
  return (
    <div className="flex gap-1.5">
      <button disabled={busy} onClick={() => stop(false)} className="rounded-md border border-night-600 px-2.5 py-1 text-sm text-slate-300 hover:bg-night-800">
        Stop node
      </button>
      <button disabled={busy} onClick={() => stop(true)} className="rounded-md bg-red-500/80 px-2.5 py-1 text-sm font-medium text-white hover:bg-red-500">
        Stop team
      </button>
    </div>
  );
}
