import { useMemo } from "react";
import type { Snapshot, LedgerEvent, TaskRow, Readiness } from "./api";
import { STATUS, ago } from "./ui";

export function NightView({ snap, events }: { snap: Snapshot; events: LedgerEvent[] }) {
  const counts = useMemo(() => {
    const c: Partial<Record<Readiness, number>> = {};
    for (const t of snap.tasks) c[t.readiness] = (c[t.readiness] ?? 0) + 1;
    return c;
  }, [snap.tasks]);
  const lanes = useMemo(() => {
    const order = snap.nodes.flatMap((n) => n.lanes);
    const all = [...new Set([...order, ...snap.tasks.map((t) => t.lane)])];
    return all.map((lane) => ({ lane, owner: snap.nodes.find((n) => n.lanes.includes(lane)), tasks: snap.tasks.filter((t) => t.lane === lane) }));
  }, [snap]);
  const nodeUp = useMemo(() => {
    const last = new Map<string, string>();
    for (const m of snap.board) if (m.env && (m.env.type === "node_up" || m.env.type === "node_down")) last.set(m.env.from, m.env.type);
    return last;
  }, [snap.board]);

  return (
    <div className="space-y-6">
      <Progress snap={snap} counts={counts} />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {snap.nodes.map((n) => {
          const mine = snap.tasks.filter((t) => t.state?.node === n.id);
          const runningNow = mine.filter((t) => t.readiness === "running");
          const merged = mine.filter((t) => t.readiness === "done").length;
          const up = nodeUp.get(n.id);
          const stale = mine.some((t) => t.readiness === "stale");
          return (
            <div key={n.id} className={`rounded-xl border p-4 ${n.id === snap.node.id ? "border-amber-300/40 bg-night-850" : "border-night-700 bg-night-900"}`}>
              <div className="flex items-center justify-between">
                <div className="font-medium text-white">
                  {n.name} {n.id === snap.node.id && <span className="text-xs font-normal text-amber-300">· this Mac</span>}
                </div>
                <span className={`text-xs ${stale ? "text-orange-300" : up === "node_up" ? "text-emerald-300" : "text-slate-500"}`}>
                  {stale ? "silent: claims going stale" : up === "node_up" ? "online" : up === "node_down" ? "finished" : "not started"}
                </span>
              </div>
              <div className="mt-0.5 text-xs text-slate-400">lanes: {n.lanes.join(", ")}</div>
              <div className="mt-3 flex items-end justify-between">
                <div className="text-sm text-slate-300">
                  <span className="text-2xl font-semibold tabular-nums text-white">{merged}</span> merged
                  {runningNow.length > 0 && <span className="ml-2 text-indigo-200">· {runningNow.length} running</span>}
                </div>
                <div className="text-xs tabular-nums text-slate-400">${(snap.spent[n.id] ?? 0).toFixed(2)} / ${snap.budget.node_usd}</div>
              </div>
              {runningNow.length > 0 && (
                <div className="mt-2 truncate text-xs text-indigo-200/80">
                  {runningNow.map((t) => t.id).join(", ")}
                </div>
              )}
            </div>
          );
        })}
      </section>

      {snap.running.length > 0 && (
        <section>
          <H>Agents working on this Mac</H>
          <div className="grid gap-3 lg:grid-cols-2">
            {snap.running.map((r) => (
              <div key={r.task} className="rounded-xl border border-indigo-400/30 bg-indigo-500/[0.07] p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium text-white">
                    {r.task} <span className="font-normal text-slate-300">{r.title}</span>
                  </div>
                  <span className="shrink-0 rounded-full bg-indigo-400/20 px-2 py-0.5 text-xs text-indigo-100">{r.phase}</span>
                </div>
                <div className="mt-1 text-xs text-slate-400">
                  {r.role} · lane {r.lane}
                  {r.stolen && " · stolen"} · attempt {r.attempt} · started {ago(r.startedAt)} · active {ago(r.lastActivity)} · ${r.cost.toFixed(2)}
                  {r.inboxWaiting > 0 && <span className="text-cyan-300"> · {r.inboxWaiting} message(s) queued</span>}
                </div>
                {r.lastText && <p className="mt-2 line-clamp-3 text-sm text-slate-300">{r.lastText}</p>}
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <H>Task graph by lane</H>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {lanes.map(({ lane, owner, tasks }) => (
            <div key={lane} className="rounded-xl border border-night-700 bg-night-900/60 p-3">
              <div className="mb-2 flex items-baseline justify-between px-1">
                <span className="font-medium capitalize text-white">{lane}</span>
                <span className="text-xs text-slate-500">{owner?.name ?? "no owner"}</span>
              </div>
              <div className="space-y-2">
                {tasks.map((t) => (
                  <TaskCard key={t.id} t={t} snap={snap} />
                ))}
                {!tasks.length && <div className="px-1 text-sm text-slate-500">No tasks</div>}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <H>Live activity (this Mac)</H>
        <div className="scroll-thin max-h-96 overflow-auto rounded-xl border border-night-700 bg-night-900 font-mono text-xs">
          {[...events]
            .reverse()
            .filter((e) => !["agent_inbox"].includes(e.kind))
            .slice(0, 150)
            .map((e, i) => (
              <div key={i} className="flex gap-3 border-b border-night-800 px-3 py-1.5">
                <span className="shrink-0 text-slate-500">{new Date(e.at).toLocaleTimeString()}</span>
                <span className={`w-28 shrink-0 ${e.kind.includes("denied") || e.kind === "error" ? "text-red-300" : e.kind.startsWith("task_") ? "text-emerald-300" : "text-slate-400"}`}>{e.kind}</span>
                <span className="w-20 shrink-0 text-amber-200">{e.task ?? ""}</span>
                <span className="truncate text-slate-300">{describe(e)}</span>
              </div>
            ))}
          {!events.length && <div className="p-4 text-slate-500">No activity yet.</div>}
        </div>
      </section>
    </div>
  );
}

function describe(e: LedgerEvent): string {
  const d = e.data ?? {};
  if (e.kind === "agent_tool") {
    const i = (d.input ?? {}) as Record<string, string>;
    return `${d.tool} ${i.command ?? i.file_path ?? i.path ?? i.pattern ?? ""}`;
  }
  if (typeof d.text === "string") return d.text;
  if (typeof d.why === "string") return d.why;
  return JSON.stringify(d).slice(0, 300);
}

function TaskCard({ t, snap }: { t: TaskRow; snap: Snapshot }) {
  const s = STATUS[t.readiness];
  const node = snap.nodes.find((n) => n.id === t.state?.node);
  return (
    <div className={`rounded-lg border px-3 py-2 ${s.card}`} title={`lease: ${t.lease.join(", ")}`}>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${s.dot}`} />
        <span className="text-xs font-semibold text-slate-200">{t.id}</span>
        <span className={`ml-auto text-[11px] ${s.text}`}>{s.label}</span>
      </div>
      <div className="mt-0.5 text-sm leading-snug text-slate-200">{t.title}</div>
      <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-slate-500">
        {t.role !== "builder" && <span className="text-sky-300">{t.role}</span>}
        {node && <span>{node.name}</span>}
        {t.depends_on.length > 0 && <span>after {t.depends_on.join(", ")}</span>}
        {t.state?.merge && <code className="text-emerald-300/80">{t.state.merge.slice(0, 7)}</code>}
      </div>
      {t.readiness === "parked" && t.state?.note && <div className="mt-1 line-clamp-3 text-xs text-amber-200/80">{t.state.note}</div>}
    </div>
  );
}

function Progress({ snap, counts }: { snap: Snapshot; counts: Partial<Record<Readiness, number>> }) {
  const total = snap.tasks.length || 1;
  const order: Readiness[] = ["done", "running", "stale", "ready", "waiting", "parked", "blocked"];
  return (
    <section className="rounded-xl border border-night-700 bg-night-900 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-white">
          <span className="text-3xl font-semibold tabular-nums">{counts.done ?? 0}</span>
          <span className="text-slate-400"> / {snap.tasks.length} tasks merged into </span>
          <code className="text-amber-200">{snap.branch}</code>
        </div>
        <div className="flex flex-wrap gap-3 text-xs">
          {order.map((k) =>
            counts[k] ? (
              <span key={k} className="flex items-center gap-1.5 text-slate-300">
                <span className={`h-2 w-2 rounded-full ${STATUS[k].dot}`} />
                {counts[k]} {STATUS[k].label}
              </span>
            ) : null,
          )}
        </div>
      </div>
      <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-night-800">
        {order.map((k) => (counts[k] ? <div key={k} className={STATUS[k].dot.replace("pulse-dot", "")} style={{ width: `${((counts[k] ?? 0) / total) * 100}%` }} /> : null))}
      </div>
    </section>
  );
}

export function H({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-400">{children}</h2>;
}
