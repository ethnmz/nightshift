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
  return <div className={`rounded-2xl bg-night-900 p-5 ring-1 ring-white/5 sm:p-6 ${className}`}>{children}</div>;
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
  const k = {
    primary: "bg-indigo-500 text-white hover:bg-indigo-400 shadow-lg shadow-indigo-500/20",
    soft: "bg-white/5 text-slate-200 hover:bg-white/10",
    ghost: "text-slate-300 hover:bg-white/5",
    danger: "bg-red-500/90 text-white hover:bg-red-500",
  }[kind];
  return (
    <button type={type} onClick={onClick} disabled={disabled || busy} className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${k} ${className}`}>
      {busy && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-200">{label}</span>
      {hint && <span className="ml-2 text-xs text-slate-500">{hint}</span>}
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

const inputCls = "w-full rounded-xl bg-night-950 px-3.5 py-2.5 text-sm text-slate-100 ring-1 ring-white/10 outline-none placeholder:text-slate-600 focus:ring-indigo-400/60";
export function Input(p: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={`${inputCls} ${p.className ?? ""}`} />;
}
export function Text(p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={3} {...p} className={`${inputCls} resize-y ${p.className ?? ""}`} />;
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-xl bg-night-950 p-1 ring-1 ring-white/10">
      {options.map(([v, l]) => (
        <button key={v} type="button" onClick={() => onChange(v)} className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${value === v ? "bg-indigo-500 text-white" : "text-slate-400 hover:text-slate-200"}`}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button type="button" onClick={() => onChange(!on)} className="flex w-full items-start gap-3 rounded-xl p-2 text-left hover:bg-white/[0.03]">
      <span className={`mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition ${on ? "bg-indigo-500" : "bg-night-700"}`}>
        <span className={`h-4 w-4 rounded-full bg-white transition ${on ? "translate-x-4" : ""}`} />
      </span>
      <span>
        <span className="block text-sm text-slate-200">{label}</span>
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </span>
    </button>
  );
}

export function Note({ kind = "info", children }: { kind?: "info" | "ok" | "error" | "warn"; children: ReactNode }) {
  const k = { info: "bg-indigo-500/10 text-indigo-100", ok: "bg-emerald-500/10 text-emerald-200", error: "bg-red-500/10 text-red-200", warn: "bg-amber-500/10 text-amber-100" }[kind];
  return <div className={`whitespace-pre-wrap rounded-xl px-4 py-3 text-sm ${k}`}>{children}</div>;
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
      className="rounded-lg bg-white/5 px-2.5 py-1 text-xs text-slate-300 hover:bg-white/10"
    >
      {done ? "Copied" : label}
    </button>
  );
}

export function Code({ children }: { children: string }) {
  return (
    <div className="flex items-start gap-2 rounded-xl bg-night-950 p-3 ring-1 ring-white/5">
      <code className="flex-1 whitespace-pre-wrap break-all font-mono text-xs text-amber-100">{children}</code>
      <Copy text={children} />
    </div>
  );
}

export const STATUS: Record<Readiness, { label: string; dot: string; text: string }> = {
  done: { label: "merged", dot: "bg-emerald-400", text: "text-emerald-300" },
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
