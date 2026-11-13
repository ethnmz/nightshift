// Small shared building blocks. One accent (indigo), one warm highlight (amber), lots of space.
import { useState, type ReactNode } from "react";
import type { Readiness } from "./api";

export function Moon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <path d="M20 4a12 12 0 1 0 8 20A10 10 0 0 1 20 4z" fill="currentColor" />
    </svg>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-md border border-night-700 bg-night-900 p-5 transition-colors duration-300 hover:border-night-600 sm:p-7 ${className}`}>{children}</div>;
}

export function Button({
  children,
  onClick,
  kind = "primary",
  disabled,
  busy,
  className = "",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: "primary" | "ghost" | "danger" | "soft";
  disabled?: boolean;
  busy?: boolean;
  className?: string;
  type?: "button" | "submit";
}) {
  // Pill buttons: cream primary, outlined secondary (dark Retool).
  const k = {
    primary: "bg-cream text-night-950 hover:bg-white hover:shadow-[0_8px_24px_-10px_rgba(236,235,228,0.55)]",
    soft: "border border-cream/30 text-cream hover:border-cream/80 hover:bg-white/[0.06]",
    ghost: "text-slate-300 hover:text-white hover:bg-white/[0.04]",
    danger: "bg-red-500/90 text-white hover:bg-red-500",
  }[kind];
  return (
    <button type={type} onClick={onClick} disabled={disabled || busy} className={`btn group inline-flex select-none items-center justify-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition-[transform,background-color,border-color,box-shadow,color] duration-200 ease-out hover:-translate-y-px active:translate-y-0 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40 ${k} ${className}`}>
      {busy && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-[13px] font-medium text-cream">{label}</span>
      {hint && <span className="ml-2 text-xs text-neutral-500">{hint}</span>}
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

const inputCls = "w-full rounded-md border border-night-700 bg-[#0c0c0c] px-3.5 py-2.5 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 transition-[border-color,box-shadow] duration-200 hover:border-night-600 focus:border-copper/70 focus:shadow-[0_0_0_4px_rgba(74,157,104,0.12)]";
export function Input(p: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={`${inputCls} ${p.className ?? ""}`} />;
}
export function Text(p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={3} {...p} className={`${inputCls} resize-y ${p.className ?? ""}`} />;
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-full border border-night-700 bg-[#0c0c0c] p-0.5">
      {options.map(([v, l]) => (
        <button key={v} type="button" onClick={() => onChange(v)} className={`rounded-full px-3 py-1 text-xs font-medium transition-all duration-200 ease-out active:scale-95 ${value === v ? "bg-cream text-night-950 shadow-[0_2px_10px_-4px_rgba(236,235,228,0.6)]" : "text-neutral-400 hover:bg-white/[0.05] hover:text-neutral-200"}`}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} className="group flex w-full items-start gap-3 rounded-md p-2 text-left transition-colors duration-200 hover:bg-white/[0.035]">
      <span className={`mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors duration-300 ${on ? "bg-copper" : "bg-night-700 group-hover:bg-night-600"}`}>
        <span className={`h-4 w-4 rounded-full bg-cream shadow transition-transform duration-300 [transition-timing-function:cubic-bezier(.34,1.56,.64,1)] ${on ? "translate-x-4" : ""}`} />
      </span>
      <span>
        <span className="block text-sm text-slate-200">{label}</span>
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </span>
    </button>
  );
}

export function Note({ kind = "info", children }: { kind?: "info" | "ok" | "error" | "warn"; children: ReactNode }) {
  const k = { info: "border-copper text-neutral-200", ok: "border-emerald-400 text-emerald-100", error: "border-red-400 text-red-200", warn: "border-amber-300 text-amber-100" }[kind];
  return <div className={`fade-in whitespace-pre-wrap rounded-md border-l-2 bg-night-850 px-4 py-3 text-sm ${k}`}>{children}</div>;
}

export function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      className={`rounded-full border px-2.5 py-0.5 text-xs transition-all duration-200 active:scale-95 ${done ? "border-copper/70 text-copper" : "border-night-600 text-neutral-300 hover:border-cream/60 hover:text-cream"}`}
    >
      {done ? "✓ Copied" : label}
    </button>
  );
}

export function Code({ children }: { children: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-night-700 bg-[#0c0c0c] p-3">
      <code className="flex-1 whitespace-pre-wrap break-all font-mono text-xs text-cream">{children}</code>
      <Copy text={children} />
    </div>
  );
}

export const STATUS: Record<Readiness, { label: string; dot: string; text: string }> = {
  done: { label: "merged", dot: "bg-cream", text: "text-cream" },
  running: { label: "building", dot: "bg-indigo-300 pulse-dot", text: "text-indigo-200" },
  stale: { label: "moving", dot: "bg-orange-400", text: "text-orange-300" },
  ready: { label: "ready", dot: "bg-sky-300", text: "text-sky-200" },
  waiting: { label: "waiting", dot: "bg-slate-600", text: "text-slate-500" },
  parked: { label: "for the morning", dot: "bg-amber-400", text: "text-amber-300" },
  blocked: { label: "blocked", dot: "bg-red-400", text: "text-red-300" },
};

export const agentLabel = (a?: string) => (a === "codex" ? "Codex" : a === "fake" ? "Practice" : "Claude");
export const initials = (n: string) =>
  n
    .split(/\s+/)
    .map((x) => x[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

export function ago(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}

/** Small square label above a heading, like "Use cases" on the dark Retool site. */
export function Tag({ children }: { children: ReactNode }) {
  return <span className="inline-block rounded-sm bg-night-800 px-2 py-0.5 text-[11px] font-medium tracking-wide text-neutral-300">{children}</span>;
}

/** Big light headline + muted sub line. */
export function Title({ tag, title, sub }: { tag?: string; title: string; sub?: string }) {
  return (
    <div>
      {tag && <Tag>{tag}</Tag>}
      <h2 className="mt-3 text-3xl font-light leading-tight text-cream sm:text-4xl">{title}</h2>
      {sub && <p className="mt-2 max-w-2xl text-sm leading-relaxed text-neutral-400">{sub}</p>}
    </div>
  );
}

/** Copper rays fanning from a corner (decorative). */
export function Rays({ className = "" }: { className?: string }) {
  const lines = Array.from({ length: 22 }, (_, i) => i);
  return (
    <svg viewBox="0 0 400 220" className={className} aria-hidden preserveAspectRatio="none">
      {lines.map((i) => (
        <line key={i} x1="0" y1="0" x2={400} y2={i * 11} stroke="#4a9d68" strokeOpacity={0.55 - i * 0.02} strokeWidth="0.8" />
      ))}
    </svg>
  );
}

/** Shimmering placeholder while something loads. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`shimmer rounded-md ${className}`} />;
}
