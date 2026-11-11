import { useEffect, useMemo, useRef, useState } from "react";
import { api, AppState, BoardRow, NodeSpec, Snapshot, TaskRow } from "./api";
import { Button, Card, Note, STATUS, agentLabel, ago, initials } from "./ui";

// ---------- layout ----------
const W = 900;
const H = 440;
const HUB = { x: W / 2, y: H / 2 - 12 };
function place(n: number, i: number) {
  if (n === 1) return { x: HUB.x - 260, y: HUB.y };
  const a = -Math.PI / 2 + (i * 2 * Math.PI) / n + (n === 2 ? Math.PI / 2 : 0);
  return { x: HUB.x + Math.cos(a) * 330, y: HUB.y + Math.sin(a) * 140 };
}

type Kind = "merge" | "handoff" | "ask" | "answer" | "release" | "note";
const KIND: Record<Kind, { color: string; label: string }> = {
  merge: { color: "#34d399", label: "merged" },
  handoff: { color: "#fbbf24", label: "unblocked" },
  ask: { color: "#67e8f9", label: "asks" },
  answer: { color: "#a5f3fc", label: "answers" },
  release: { color: "#fb923c", label: "hands off" },
  note: { color: "#c4b5fd", label: "note" },
};
interface Packet {
  key: string;
  from: string; // node id or "hub"
  to: string;
  kind: Kind;
  label: string;
  born: number;
}

/** Turn a board message into a packet moving between teammates (or into the night branch). */
function toPacket(m: BoardRow, snap: Snapshot): Packet | null {
  const e = m.env;
  if (!e) return null;
  const tasks = new Map(snap.tasks.map((t) => [t.id, t]));
  const laneOwner = (lane: string) => snap.nodes.find((n) => n.lanes.includes(lane))?.id;
  const target = (to: string) => (to.startsWith("lane:") ? laneOwner(to.slice(5)) : to.startsWith("node:") ? to.slice(5) : to.startsWith("task:") ? tasks.get(to.slice(5))?.state?.node : undefined);
  const t = e.task ? tasks.get(e.task) : undefined;
  const base = { key: m.id, born: 0 };
  switch (e.type) {
    case "task_done":
      return { ...base, from: e.from, to: "hub", kind: "merge", label: e.task ?? "" };
    case "task_claimed": {
      if (e.body.takeover) return { ...base, from: String(e.body.takeover), to: e.from, kind: "release", label: `${e.task} takeover` };
      if (e.body.stolen && t) {
        const owner = laneOwner(t.lane);
        if (owner && owner !== e.from) return { ...base, from: owner, to: e.from, kind: "handoff", label: `${e.task} picked up` };
      }
      const dep = t?.depends_on.map((d) => tasks.get(d)?.state?.node).find((n) => n && n !== e.from);
      return dep ? { ...base, from: dep, to: e.from, kind: "handoff", label: `${e.task} unblocked` } : null;
    }
    case "task_released":
      return { ...base, from: e.from, to: "hub", kind: "release", label: `${e.task} handed back` };
    case "ask": {
      const to = target(e.to);
      return to && to !== e.from ? { ...base, from: e.from, to, kind: "ask", label: "question" } : null;
    }
    case "answer": {
      const to = target(e.to);
      return to && to !== e.from ? { ...base, from: e.from, to, kind: "answer", label: "answer" } : null;
    }
    case "note":
    case "contract_change":
    case "lease_request": {
      const to = target(e.to);
      return to && to !== e.from ? { ...base, from: e.from, to, kind: "note", label: e.type === "note" ? "note" : "change request" } : null;
    }
  }
  return null;
}

function sentence(m: BoardRow, snap: Snapshot): string | null {
  const e = m.env;
  if (!e) return null;
  const node = snap.nodes.find((n) => n.id === e.from);
  const who = node ? `${node.name}'s ${agentLabel(node.agent ?? snap.agent)}` : e.from;
  const t = snap.tasks.find((x) => x.id === e.task);
  const title = t ? t.title : e.task;
  const b = e.body;
  switch (e.type) {
    case "task_done":
      return `${who} merged “${title}”`;
    case "task_claimed":
      return b.takeover ? `${who} took over “${title}” from ${b.takeover}` : b.stolen ? `${who} picked up “${title}” to help out` : `${who} started “${title}”`;
    case "task_parked":
      return `“${title}” is set aside for the morning`;
    case "task_released":
      return `${who} hit a plan limit and handed back “${title}”`;
    case "ask":
      return `${who} asked ${e.to.replace("lane:", "")}: ${String(b.question ?? "").slice(0, 120)}`;
    case "answer":
      return `${who} answered: ${String(b.text ?? "").slice(0, 120)}`;
    case "assumption":
      return `${who} decided: ${String(b.decision ?? "").slice(0, 120)}`;
    case "note":
      return String(b.text ?? "").includes("usage limit") ? `${who} hit its plan limit and is pausing` : `${who}: ${String(b.text ?? "").slice(0, 120)}`;
    case "gate_failed":
      return `The full check failed. A fix task was queued.`;
    case "gate_passed":
      return `The full check passed`;
    case "node_up":
      return `${node?.name ?? e.from}'s computer joined the night`;
    case "node_down":
      return `${node?.name ?? e.from}'s computer finished`;
    case "ready":
      return `${node?.name ?? e.from}'s computer is ready`;
  }
  return null;
}

export function Tonight({ app, reload }: { app: AppState; reload: () => Promise<AppState | null> }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [err, setErr] = useState("");
  const [packets, setPackets] = useState<Packet[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const s = await api.snapshot();
        if (!alive) return;
        setSnap(s);
        setErr("");
        // Animate board messages we have not seen; on first load, replay the last few.
        const all = s.board.map((m) => ({ m, p: toPacket(m, s) })).filter((x) => x.p);
        let fresh: typeof all;
        if (!seen.current) {
          seen.current = new Set(s.board.map((m) => m.id));
          fresh = all.slice(-5);
        } else fresh = all.filter((x) => !seen.current!.has(x.m.id));
        for (const m of s.board) seen.current.add(m.id);
        fresh.forEach((x, i) =>
          setTimeout(() => {
            if (!alive) return;
            const p = { ...x.p!, born: Date.now(), key: `${x.p!.key}-${Date.now()}` };
            setPackets((cur) => [...cur.filter((c) => Date.now() - c.born < 3200), p]);
          }, i * 650),
        );
      } catch (e) {
        if (alive) setErr(String((e as Error).message));
      }
    };
    void load();
    const t = setInterval(load, 2500);
    const gc = setInterval(() => setPackets((cur) => cur.filter((c) => Date.now() - c.born < 3200)), 1000);
    return () => {
      alive = false;
      clearInterval(t);
      clearInterval(gc);
    };
  }, []);

  const positions = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    snap?.nodes.forEach((n, i) => m.set(n.id, place(snap.nodes.length, i)));
    m.set("hub", HUB);
    return m;
  }, [snap?.nodes]);

  if (err && !snap) return <Note>{err.includes("setup") ? "Finish the setup first (share the plan and set up this computer), then come back here." : err}</Note>;
  if (!snap) return <div className="py-20 text-center text-slate-500">Loading…</div>;

  const done = snap.tasks.filter((t) => t.readiness === "done").length;
  const parked = snap.tasks.filter((t) => t.readiness === "parked").length;
  const spent = Object.values(snap.spent).reduce((a, b) => a + b, 0);
  const statusOf = (n: NodeSpec) => {
    const evs = snap.board.filter((m) => m.env?.from === n.id && (m.env.type === "node_up" || m.env.type === "node_down"));
    const last = evs[evs.length - 1]?.env?.type;
    const u = snap.usage[n.id];
    const pausedUntil = n.id === snap.node.id ? snap.pausedUntil : u?.status === "limited" ? u.resetsAt ?? 0 : 0;
    const working = snap.tasks.filter((t) => t.readiness === "running" && t.state?.node === n.id);
    if (pausedUntil > Date.now()) return { key: "paused" as const, working, text: `paused until ${new Date(pausedUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` };
    if (last === "node_down") return { key: "finished" as const, working, text: "finished" };
    if (working.length) return { key: "working" as const, working, text: working.map((t) => t.title).join(" · ") };
    if (last === "node_up") return { key: "idle" as const, working, text: "waiting for work" };
    return { key: "offline" as const, working, text: "not started" };
  };
  const feed = snap.board
    .map((m) => ({ m, s: sentence(m, snap) }))
    .filter((x) => x.s)
    .slice(-9)
    .reverse();
  const running = !!(snap.live || snap.daemonPid) && !snap.finished;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <div>
          <div className="text-3xl font-semibold tabular-nums text-white">
            {done}
            <span className="text-lg text-slate-500"> / {snap.tasks.length} merged</span>
          </div>
          <div className="text-sm text-slate-400">
            Night of {snap.night}
            {parked ? ` · ${parked} set aside for the morning` : ""}
            {snap.agent !== "fake" && snap.auth === "subscription" ? ` · est. usage $${spent.toFixed(2)} (not billed)` : ""}
          </div>
        </div>
        <div className="h-2 min-w-40 flex-1 overflow-hidden rounded-full bg-night-800">
          <div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: `${(done / Math.max(1, snap.tasks.length)) * 100}%` }} />
        </div>
        <div className="relative">
          {running ? (
            <Button kind="ghost" onClick={() => setStopOpen(!stopOpen)}>
              Stop…
            </Button>
          ) : snap.finished ? (
            <span className="text-sm text-emerald-300">Night finished. See Morning.</span>
          ) : null}
          {stopOpen && (
            <div className="absolute right-0 z-10 mt-1 w-56 space-y-1 rounded-xl bg-night-850 p-2 shadow-xl ring-1 ring-white/10">
              <button className="w-full rounded-lg px-3 py-2 text-left text-sm text-slate-200 hover:bg-white/5" onClick={async () => (await api.stop(false), setStopOpen(false), void reload())}>
                Stop this computer
              </button>
              <button className="w-full rounded-lg px-3 py-2 text-left text-sm text-red-300 hover:bg-red-500/10" onClick={async () => (await api.stop(true), setStopOpen(false), void reload())}>
                Stop everyone
              </button>
            </div>
          )}
        </div>
      </div>

      <Card className="overflow-hidden p-0 sm:p-0">
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full">
          <defs>
            <radialGradient id="hubglow">
              <stop offset="0%" stopColor="#fbbf24" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#fbbf24" stopOpacity="0" />
            </radialGradient>
          </defs>
          {/* spokes */}
          {snap.nodes.map((n) => {
            const p = positions.get(n.id)!;
            return <line key={n.id} x1={p.x} y1={p.y} x2={HUB.x} y2={HUB.y} stroke="white" strokeOpacity="0.05" strokeWidth="1.5" />;
          })}
          {/* hub: the shared night branch */}
          <circle cx={HUB.x} cy={HUB.y} r="70" fill="url(#hubglow)" />
          <circle cx={HUB.x} cy={HUB.y} r="34" fill="#16213a" stroke="#fbbf24" strokeOpacity="0.5" />
          <path transform={`translate(${HUB.x - 12} ${HUB.y - 16}) scale(0.8)`} d="M20 4a12 12 0 1 0 8 20A10 10 0 0 1 20 4z" fill="#fbbf24" />
          <text x={HUB.x} y={HUB.y + 54} textAnchor="middle" className="fill-slate-400" fontSize="12">
            night branch · {done} merged
          </text>

          {/* packets */}
          {packets.map((pk) => {
            const a = positions.get(pk.from);
            const b = positions.get(pk.to);
            if (!a || !b) return null;
            const mx = (a.x + b.x) / 2;
            const my = (a.y + b.y) / 2;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const len = Math.hypot(dx, dy) || 1;
            const bend = pk.to === "hub" || pk.from === "hub" ? 0.12 : 0.28;
            const cx = mx - (dy / len) * len * bend;
            const cy = my + (dx / len) * len * bend;
            const d = `M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}`;
            const k = KIND[pk.kind];
            return (
              <g key={pk.key} className="packet">
                <path d={d} fill="none" stroke={k.color} strokeOpacity="0.55" strokeWidth="2" strokeDasharray="6 6" className="dash-flow" />
                <circle r="7" fill={k.color}>
                  <animateMotion dur="1.5s" fill="freeze" path={d} keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines="0.4 0 0.2 1" />
                </circle>
                <text x={cx} y={cy - 8} textAnchor="middle" fontSize="12" fontWeight="600" fill={k.color} stroke="#0c1222" strokeWidth="4" paintOrder="stroke" className="packet-label">
                  {pk.label}
                </text>
              </g>
            );
          })}

          {/* teammates */}
          {snap.nodes.map((n) => {
            const p = positions.get(n.id)!;
            const st = statusOf(n);
            const ring = { working: "#818cf8", paused: "#fbbf24", finished: "#34d399", idle: "#64748b", offline: "#334155" }[st.key];
            return (
              <g key={n.id} opacity={st.key === "offline" ? 0.55 : 1}>
                {st.key === "working" && <circle cx={p.x} cy={p.y} r="40" fill="none" stroke={ring} strokeWidth="2" strokeDasharray="10 8" className="spin-slow" style={{ transformOrigin: `${p.x}px ${p.y}px` }} />}
                <circle cx={p.x} cy={p.y} r="32" fill="#111a2e" stroke={ring} strokeWidth="2.5" />
                <text x={p.x} y={p.y + 5} textAnchor="middle" fontSize="15" fontWeight="600" fill="#e2e8f0">
                  {initials(n.name)}
                </text>
                <text x={p.x} y={p.y + 54} textAnchor="middle" fontSize="13" fontWeight="600" fill="#f1f5f9">
                  {n.name} <tspan fill="#94a3b8" fontWeight="400">· {agentLabel(n.agent ?? snap.agent)}</tspan>
                </text>
                <text x={p.x} y={p.y + 71} textAnchor="middle" fontSize="11.5" fill={st.key === "paused" ? "#fbbf24" : "#94a3b8"}>
                  {st.text.length > 38 ? st.text.slice(0, 36) + "…" : st.text}
                </text>
                {st.working.length > 1 && (
                  <g>
                    <circle cx={p.x + 26} cy={p.y - 24} r="10" fill="#818cf8" />
                    <text x={p.x + 26} y={p.y - 20} textAnchor="middle" fontSize="11" fontWeight="700" fill="#0c1222">
                      {st.working.length}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-white/5 px-5 py-3 text-xs text-slate-400">
          {(Object.keys(KIND) as Kind[]).map((k) => (
            <span key={k} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: KIND[k].color }} />
              {{ merge: "work merged", handoff: "work handed to a teammate", ask: "question", answer: "answer", release: "plan limit hand-off", note: "note" }[k]}
            </span>
          ))}
        </div>
      </Card>

      <div className="grid gap-5 md:grid-cols-[1fr_1fr]">
        <Card>
          <div className="mb-3 text-sm font-medium text-white">What just happened</div>
          <ul className="space-y-2.5">
            {feed.map(({ m, s }) => (
              <li key={m.id} className="flex gap-3 text-sm">
                <span className="w-10 shrink-0 text-xs tabular-nums text-slate-500">{ago(Date.parse(m.createdAt))}</span>
                <span className="text-slate-300">{s}</span>
              </li>
            ))}
            {!feed.length && <li className="text-sm text-slate-500">Nothing yet. Once a computer starts, its agents' updates show up here.</li>}
          </ul>
        </Card>
        <Card>
          <button onClick={() => setShowAll(!showAll)} className="mb-3 flex w-full items-center text-sm font-medium text-white">
            All tasks <span className="ml-auto text-xs font-normal text-slate-500">{showAll ? "hide" : "show"}</span>
          </button>
          <TaskList tasks={snap.tasks} nodes={snap.nodes} compact={!showAll} />
        </Card>
      </div>
    </div>
  );
}

function TaskList({ tasks, nodes, compact }: { tasks: TaskRow[]; nodes: NodeSpec[]; compact: boolean }) {
  const shown = compact ? tasks.filter((t) => ["running", "parked", "stale"].includes(t.readiness)).slice(0, 8) : tasks;
  return (
    <ul className="space-y-1.5">
      {shown.map((t) => (
        <li key={t.id} className="flex items-center gap-2.5 text-sm">
          <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS[t.readiness].dot}`} />
          <span className="truncate text-slate-300">{t.title}</span>
          <span className={`ml-auto shrink-0 text-xs ${STATUS[t.readiness].text}`}>
            {STATUS[t.readiness].label}
            {t.state?.node && t.readiness !== "waiting" ? ` · ${nodes.find((n) => n.id === t.state!.node)?.name ?? t.state.node}` : ""}
          </span>
        </li>
      ))}
      {compact && !shown.length && <li className="text-sm text-slate-500">Nothing in progress right now.</li>}
    </ul>
  );
}
