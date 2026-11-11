import type { Readiness } from "./api";

export function Moon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <path d="M20 4a12 12 0 1 0 8 20A10 10 0 0 1 20 4z" fill="currentColor" />
    </svg>
  );
}

export const STATUS: Record<Readiness, { label: string; dot: string; card: string; text: string }> = {
  done: { label: "merged", dot: "bg-emerald-400", card: "border-emerald-500/30 bg-emerald-500/[0.06]", text: "text-emerald-300" },
  running: { label: "running", dot: "bg-indigo-300 pulse-dot", card: "border-indigo-400/50 bg-indigo-500/10", text: "text-indigo-200" },
  stale: { label: "stale claim", dot: "bg-orange-400", card: "border-orange-400/40 bg-orange-500/10", text: "text-orange-300" },
  ready: { label: "ready", dot: "bg-sky-300", card: "border-sky-400/30 bg-night-850", text: "text-sky-200" },
  waiting: { label: "waiting", dot: "bg-slate-500", card: "border-night-700 bg-night-900", text: "text-slate-400" },
  parked: { label: "parked", dot: "bg-amber-400", card: "border-amber-400/40 bg-amber-500/10", text: "text-amber-300" },
  blocked: { label: "blocked", dot: "bg-red-400", card: "border-red-400/30 bg-red-500/[0.06]", text: "text-red-300" },
};

export function ago(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m ago`;
}

export const TYPE_COLOR: Record<string, string> = {
  task_done: "bg-emerald-500/15 text-emerald-300",
  task_claimed: "bg-indigo-500/15 text-indigo-200",
  task_parked: "bg-amber-500/15 text-amber-300",
  task_released: "bg-amber-500/10 text-amber-200",
  task_added: "bg-sky-500/15 text-sky-200",
  assumption: "bg-fuchsia-500/15 text-fuchsia-200",
  ask: "bg-cyan-500/15 text-cyan-200",
  answer: "bg-cyan-500/15 text-cyan-100",
  blocker: "bg-red-500/15 text-red-300",
  gate_failed: "bg-red-500/20 text-red-200",
  gate_passed: "bg-emerald-500/15 text-emerald-200",
  contract_change: "bg-orange-500/15 text-orange-200",
  lease_request: "bg-orange-500/15 text-orange-200",
  stop: "bg-red-500/25 text-red-100",
};
