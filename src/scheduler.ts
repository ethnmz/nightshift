// Deterministic task selection. No model decides what runs next.
import type { NightConfig, NodeSpec, Task } from "./config.js";
import type { StateRef } from "./claims.js";
import { leasesOverlap } from "./lease.js";

export type Readiness = "done" | "parked" | "running" | "stale" | "ready" | "waiting" | "blocked";
// A released task ("open" state) is treated like an unclaimed one, but claimed by compare-and-swap.

export interface Pick {
  task: Task;
  takeover?: StateRef; // set when this is a stale claim we are taking over
  stolen: boolean;
}

export function dependents(tasks: Task[]): Map<string, number> {
  const kids = new Map<string, string[]>();
  for (const t of tasks) for (const d of t.depends_on) kids.set(d, [...(kids.get(d) ?? []), t.id]);
  const memo = new Map<string, Set<string>>();
  const reach = (id: string): Set<string> => {
    if (memo.has(id)) return memo.get(id)!;
    const s = new Set<string>();
    memo.set(id, s);
    for (const k of kids.get(id) ?? []) {
      s.add(k);
      for (const x of reach(k)) s.add(x);
    }
    return s;
  };
  return new Map(tasks.map((t) => [t.id, reach(t.id).size]));
}

/** The newest retry of each task (a parked task's dependents wait on its retry instead). */
export function retryMap(tasks: Task[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of tasks) if (t.retry_of) m.set(t.retry_of, t.id);
  return m;
}

export function readiness(tasks: Task[], states: Map<string, StateRef>, isStale: (s: StateRef) => boolean): Map<string, Readiness> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out = new Map<string, Readiness>();
  const retries = retryMap(tasks);
  // Follow a parked task to its latest retry, so its dependents are not blocked forever.
  const effective = (id: string): string => {
    const r = retries.get(id);
    return r && states.get(id)?.state.status === "parked" ? effective(r) : id;
  };
  const get = (id: string): Readiness => {
    if (out.has(id)) return out.get(id)!;
    const s = states.get(id);
    let r: Readiness;
    if (s?.state.status === "done") r = "done";
    else if (s?.state.status === "parked") r = "parked";
    else if (s?.state.status === "claimed") r = isStale(s) ? "stale" : "running";
    else {
      // no state, or released back to the team ("open")
      const deps = byId.get(id)!.depends_on.map((d) => get(effective(d)));
      if (deps.some((d) => d === "parked" || d === "blocked")) r = "blocked";
      else if (deps.every((d) => d === "done")) r = "ready";
      else r = "waiting";
    }
    out.set(id, r);
    return r;
  };
  for (const t of tasks) get(t.id);
  return out;
}

export function nightFinished(r: Map<string, Readiness>): boolean {
  return [...r.values()].every((x) => x === "done" || x === "parked" || x === "blocked");
}

export function pickNext(opts: {
  tasks: Task[];
  states: Map<string, StateRef>;
  isStale: (s: StateRef) => boolean;
  me: NodeSpec;
  cfg: NightConfig;
  localRunning: Set<string>;
  idleMs: number;
  /** Path globs humans are working on during a day shift: treated as held leases. */
  reserves?: string[][];
  /** Only demo-critical work (usage nearly spent, or close to the deadline). */
  mustOnly?: boolean;
  /** No new claims at or after this time (deadline − stop_before). */
  cutoffAt?: number;
  now?: number;
}): Pick | null {
  const { tasks, states, isStale, me, cfg, localRunning, idleMs } = opts;
  if (opts.cutoffAt !== undefined && (opts.now ?? Date.now()) >= opts.cutoffAt) return null;
  const r = readiness(tasks, states, isStale);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // Leases held right now, anywhere on the team (stale claims do not hold a lease).
  const held = [...tasks.filter((t) => r.get(t.id) === "running" || localRunning.has(t.id)).map((t) => t.lease), ...(opts.reserves ?? [])];
  const rank = dependents(tasks);
  const open = (t: Task) => (r.get(t.id) === "ready" || r.get(t.id) === "stale") && !localRunning.has(t.id);
  // A ready fixer (e.g. after a failed integration gate) reserves its lease: nobody starts new
  // overlapping work, so it cannot starve while the team keeps claiming tasks.
  const reserved = tasks.filter((t) => t.role === "fixer" && open(t)).map((t) => ({ id: t.id, lease: t.lease }));
  const candidates = tasks
    .filter(open)
    .filter((t) => !held.some((h) => leasesOverlap(h, t.lease)))
    .filter((t) => t.role === "fixer" || !reserved.some((x) => x.id !== t.id && leasesOverlap(x.lease, t.lease)))
    .filter((t) => !opts.mustOnly || t.priority !== "nice" || t.role === "fixer")
    // Must-haves first, then whatever unblocks the most work.
    .sort((a, b) => (a.priority === "nice" ? 1 : 0) - (b.priority === "nice" ? 1 : 0) || rank.get(b.id)! - rank.get(a.id)! || tasks.indexOf(a) - tasks.indexOf(b));

  const mine = candidates.filter((t) => me.lanes.includes(t.lane));
  const asPick = (t: Task, stolen: boolean): Pick => ({
    task: byId.get(t.id)!,
    takeover: r.get(t.id) === "stale" || states.get(t.id)?.state.status === "open" ? states.get(t.id) : undefined,
    stolen,
  });
  if (mine.length) return asPick(mine[0], false);
  if (!cfg.authorize.work_stealing) return null;
  if (idleMs < cfg.steal.idle_seconds * 1000) return null;
  const stealable = candidates.filter((t) => !cfg.steal.never_lanes.includes(t.lane));
  return stealable.length ? asPick(stealable[0], true) : null;
}
