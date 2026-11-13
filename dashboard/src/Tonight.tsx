import { useEffect, useMemo, useRef, useState } from "react";
import { api, AppState, BoardRow, NodeSpec, Snapshot, TaskRow } from "./api";
import { Button, Card, Input, Note, STATUS, Skeleton, agentLabel, ago, initials } from "./ui";

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
  merge: { color: "#ecebe4", label: "merged" },
  handoff: { color: "#4a9d68", label: "unblocked" },
  ask: { color: "#8fb8de", label: "asks" },
  answer: { color: "#b9d4ec", label: "answers" },
  release: { color: "#e8b04f", label: "hands off" },
  note: { color: "#b8a6e0", label: "note" },
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
  if (!snap)
    return (
      <div className="space-y-5">
        <Skeleton className="h-14 w-64" />
        <Skeleton className="h-[420px] w-full" />
        <div className="grid gap-5 md:grid-cols-2">
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
        </div>
      </div>
    );

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
          <div className="text-5xl font-light tabular-nums text-cream">
            {done}
            <span className="text-2xl text-neutral-500"> / {snap.tasks.length} merged</span>
          </div>
          <div className="text-sm text-neutral-400">
            {snap.day ? "Day shift on" : "Night of"} {snap.night}
            {snap.cutoffAt ? ` · no new tasks after ${new Date(snap.cutoffAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` : ""}
            {parked ? ` · ${parked} set aside for the morning` : ""}
            {snap.agent !== "fake" && snap.auth === "subscription" ? ` · est. usage $${spent.toFixed(2)} (not billed)` : ""}
          </div>
        </div>
        <div className="h-1 min-w-40 flex-1 overflow-hidden rounded-full bg-night-700">
          <div className="h-full rounded-full bg-copper transition-all" style={{ width: `${(done / Math.max(1, snap.tasks.length)) * 100}%` }} />
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
            <div className="absolute right-0 z-10 mt-1 w-56 space-y-1 rounded-md border border-night-600 bg-night-850 p-2 shadow-xl">
              <button className="w-full rounded-lg px-3 py-2 text-left text-sm text-neutral-200 hover:bg-white/5" onClick={async () => (await api.stop(false), setStopOpen(false), void reload())}>
                Stop this computer
              </button>
              <button className="w-full rounded-lg px-3 py-2 text-left text-sm text-red-300 hover:bg-red-500/10" onClick={async () => (await api.stop(true), setStopOpen(false), void reload())}>
                Stop everyone
              </button>
            </div>
          )}
        </div>
      </div>

      <Card className="relative overflow-hidden bg-[#141414] p-0 sm:p-0">
        <div className="copper-grid pointer-events-none absolute inset-0" />
        <svg viewBox={`0 0 ${W} ${H}`} className="relative block h-auto w-full">
          <defs>
            <radialGradient id="hubglow">
              <stop offset="0%" stopColor="#4a9d68" stopOpacity="0.28" />
              <stop offset="100%" stopColor="#4a9d68" stopOpacity="0" />
            </radialGradient>
          </defs>
          {/* spokes */}
          {snap.nodes.map((n) => {
            const p = positions.get(n.id)!;
            return <line key={n.id} x1={p.x} y1={p.y} x2={HUB.x} y2={HUB.y} stroke="#ecebe4" strokeOpacity="0.08" strokeWidth="1" />;
          })}
          {/* hub: the shared night branch */}
          <circle cx={HUB.x} cy={HUB.y} r="70" fill="url(#hubglow)" />
          <circle cx={HUB.x} cy={HUB.y} r="34" fill="#1c1c1c" stroke="#4a9d68" strokeOpacity="0.8" />
          <path transform={`translate(${HUB.x - 12} ${HUB.y - 16}) scale(0.8)`} d="M20 4a12 12 0 1 0 8 20A10 10 0 0 1 20 4z" fill="#ecebe4" />
          <text x={HUB.x} y={HUB.y + 54} textAnchor="middle" fill="#8a8a85" fontSize="11" fontFamily="JetBrains Mono, monospace">
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
                <text x={cx} y={cy - 8} textAnchor="middle" fontSize="12" fontWeight="600" fill={k.color} stroke="#141414" strokeWidth="4" paintOrder="stroke" className="packet-label">
                  {pk.label}
                </text>
              </g>
            );
          })}

          {/* teammates */}
          {snap.nodes.map((n) => {
            const p = positions.get(n.id)!;
            const st = statusOf(n);
            const ring = { working: "#4a9d68", paused: "#e8b04f", finished: "#ecebe4", idle: "#5a5a55", offline: "#333333" }[st.key];
            return (
              <g key={n.id} opacity={st.key === "offline" ? 0.55 : 1}>
                {st.key === "working" && <circle cx={p.x} cy={p.y} r="40" fill="none" stroke={ring} strokeWidth="2" strokeDasharray="10 8" className="spin-slow" style={{ transformOrigin: `${p.x}px ${p.y}px` }} />}
                <circle cx={p.x} cy={p.y} r="32" fill="#171717" stroke={ring} strokeWidth="1.5" />
                <text x={p.x} y={p.y + 5} textAnchor="middle" fontSize="15" fontWeight="500" fill="#ecebe4">
                  {initials(n.name)}
                </text>
                <text x={p.x} y={p.y + 54} textAnchor="middle" fontSize="13" fontWeight="500" fill="#ecebe4">
                  {n.name} <tspan fill="#8a8a85" fontWeight="400">· {agentLabel(n.agent ?? snap.agent)}</tspan>
                </text>
                <text x={p.x} y={p.y + 71} textAnchor="middle" fontSize="11.5" fill={st.key === "paused" ? "#e8b04f" : "#8a8a85"}>
                  {st.text.length > 38 ? st.text.slice(0, 36) + "…" : st.text}
                </text>
                {st.working.length > 1 && (
                  <g>
                    <circle cx={p.x + 26} cy={p.y - 24} r="10" fill="#4a9d68" />
                    <text x={p.x + 26} y={p.y - 20} textAnchor="middle" fontSize="11" fontWeight="700" fill="#111111">
                      {st.working.length}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
        <div className="relative flex flex-wrap gap-x-5 gap-y-1 border-t border-night-700 bg-night-900 px-5 py-3 text-xs text-neutral-400">
          {(Object.keys(KIND) as Kind[]).map((k) => (
            <span key={k} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: KIND[k].color }} />
              {{ merge: "work merged", handoff: "work handed to a teammate", ask: "question", answer: "answer", release: "plan limit hand-off", note: "note" }[k]}
            </span>
          ))}
        </div>
      </Card>

      {snap.authLost && <Note kind="warn">This computer's agent login stopped working, so its tasks went to teammates. Sign in again ({snap.agent === "codex" ? "codex login" : "run claude, then /login"}); it resumes on its own within 30 minutes.</Note>}
      <DayShift snap={snap} running={running} reload={reload} />
      <div className="grid gap-5 md:grid-cols-[1fr_1fr]">
        <Card>
          <div className="mb-4 text-lg font-light text-cream">What just happened</div>
          <ul className="stagger space-y-1">
            {feed.map(({ m, s }) => (
              <li key={m.id} className="-mx-2 flex gap-3 rounded-md px-2 py-1 text-sm transition-colors duration-200 hover:bg-white/[0.03]">
                <span className="w-10 shrink-0 text-xs tabular-nums text-neutral-500">{ago(Date.parse(m.createdAt))}</span>
                <span className="text-neutral-300">{s}</span>
              </li>
            ))}
            {!feed.length && <li className="text-sm text-neutral-500">Nothing yet. Once a computer starts, its agents' updates show up here.</li>}
          </ul>
        </Card>
        <Card>
          <button onClick={() => setShowAll(!showAll)} className="mb-3 flex w-full items-center text-sm font-medium text-white">
            <span className="text-lg font-light text-cream">All tasks</span> <span className="ml-auto text-xs font-normal text-neutral-500">{showAll ? "hide" : "show"}</span>
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
        <li key={t.id} className="-mx-2 flex items-center gap-2.5 rounded-md px-2 py-1 text-sm transition-colors duration-200 hover:bg-white/[0.03]">
          <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS[t.readiness].dot}`} />
          <span className="truncate text-neutral-300">{t.title}</span>
          <span className={`ml-auto shrink-0 text-xs ${STATUS[t.readiness].text}`}>
            {STATUS[t.readiness].label}
            {t.state?.node && t.readiness !== "waiting" ? ` · ${nodes.find((n) => n.id === t.state!.node)?.name ?? t.state.node}` : ""}
          </span>
        </li>
      ))}
      {compact && !shown.length && <li className="text-sm text-neutral-500">Nothing in progress right now.</li>}
    </ul>
  );
}

/** Day shift: keep agents building leftovers and retries while people work, outside reserved folders. */
function DayShift({ snap, running, reload }: { snap: Snapshot; running: boolean; reload: () => Promise<AppState | null> }) {
  const mine = snap.reserves?.[snap.node.id] ?? [];
  const [text, setText] = useState(mine.join(", "));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const others = Object.entries(snap.reserves ?? {}).filter(([id, g]) => id !== snap.node.id && g.length);
  const left = snap.tasks.filter((t) => ["ready", "waiting", "stale"].includes(t.readiness)).length;
  const save = async (globs: string[]) => {
    setBusy(true);
    try {
      await api.reserve(globs);
      setMsg(globs.length ? "Agents will stay out of those folders." : "Folders released.");
    } catch (e) {
      setMsg(String((e as Error).message));
    }
    setBusy(false);
  };
  if (running && !snap.day && !mine.length) return null;
  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <div className="text-lg font-light text-cream">Day shift</div>
          <p className="text-sm text-neutral-400">Keep agents building {left ? `the ${left} unfinished task${left === 1 ? "" : "s"} and any retries` : "retries"} while you work. Tell them which folders you're editing so they stay out.</p>
        </div>
        {!running && (
          <div className="flex gap-2">
            <Button kind="soft" busy={busy} onClick={async () => (await api.start(false, true), void reload())}>
              Start on this computer
            </Button>
            <Button busy={busy} onClick={async () => (await api.start(true, true), void reload())}>
              Start for everyone
            </Button>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input className="min-w-60 flex-1" placeholder="Folders we're working on, e.g. frontend/src/screens/**, docs/**" value={text} onChange={(e) => setText(e.target.value)} />
        <Button kind="soft" busy={busy} onClick={() => save(text.split(",").map((x) => x.trim()).filter(Boolean))}>
          Reserve
        </Button>
        {mine.length > 0 && (
          <Button kind="ghost" onClick={() => (setText(""), save([]))}>
            Release
          </Button>
        )}
      </div>
      {others.length > 0 && <div className="text-xs text-neutral-500">Also reserved: {others.map(([id, g]) => `${snap.nodes.find((n) => n.id === id)?.name ?? id}: ${g.join(", ")}`).join(" · ")}</div>}
      {msg && <div className="text-xs text-copper">{msg}</div>}
    </Card>
  );
}
