import { useMemo, useState } from "react";
import type { Snapshot } from "./api";
import { TYPE_COLOR } from "./ui";

const GROUPS: Record<string, string[]> = {
  all: [],
  talk: ["note", "ask", "answer"],
  decisions: ["assumption", "contract_change", "lease_request", "blocker"],
  tasks: ["task_claimed", "task_done", "task_parked", "task_added"],
  health: ["node_up", "node_down", "gate_passed", "gate_failed", "budget", "stop"],
};

export function BoardView({ snap }: { snap: Snapshot }) {
  const [group, setGroup] = useState("all");
  const rows = useMemo(() => {
    const allow = GROUPS[group];
    return [...snap.board].reverse().filter((m) => !allow.length || (m.env && allow.includes(m.env.type)));
  }, [snap.board, group]);
  const name = (id: string) => snap.nodes.find((n) => n.id === id)?.name ?? id;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {Object.keys(GROUPS).map((g) => (
          <button key={g} onClick={() => setGroup(g)} className={`rounded-full px-3 py-1 text-sm capitalize ${group === g ? "bg-amber-300 text-night-950" : "bg-night-800 text-slate-300 hover:bg-night-700"}`}>
            {g}
          </button>
        ))}
        <span className="ml-auto text-xs text-slate-500">Structured posts on the team board. Humans can post "nightshift stop" to halt every node.</span>
      </div>
      <div className="divide-y divide-night-800 overflow-hidden rounded-xl border border-night-700 bg-night-900">
        {rows.map((m) => {
          const e = m.env;
          const text = e ? String(e.body.text ?? e.body.question ?? e.body.decision ?? e.body.why ?? e.body.change ?? "") : "";
          return (
            <div key={m.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {e ? <span className={`rounded px-1.5 py-0.5 font-medium ${TYPE_COLOR[e.type] ?? "bg-night-700 text-slate-300"}`}>{e.type}</span> : <span className="rounded bg-night-700 px-1.5 py-0.5 text-slate-300">human</span>}
                <span className="text-slate-300">{e ? name(e.from) : m.author}</span>
                {e && e.to !== "*" && <span className="text-slate-500">→ {e.to}</span>}
                {e?.task && <span className="text-amber-200">{e.task}</span>}
                <span className="ml-auto text-slate-500">{new Date(m.createdAt).toLocaleTimeString()}</span>
              </div>
              <div className="mt-1 text-sm text-slate-200">{m.text.replace(/^\[[^\]]+\]\s*/, "")}</div>
              {text && text !== m.text && text.length > 0 && !m.text.includes(text.slice(0, 60)) && <div className="mt-1 whitespace-pre-wrap text-xs text-slate-400">{text.slice(0, 800)}</div>}
              {e?.type === "assumption" && typeof e.body.why === "string" && <div className="mt-1 text-xs text-fuchsia-200/70">why: {e.body.why}</div>}
            </div>
          );
        })}
        {!rows.length && <div className="p-6 text-center text-slate-500">Nothing here yet.</div>}
      </div>
    </div>
  );
}
