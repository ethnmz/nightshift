import { useEffect, useState, type ReactNode } from "react";
import { api } from "./api";

export function ReportView() {
  const [md, setMd] = useState<string | null>(null);
  const [file, setFile] = useState("");
  const [err, setErr] = useState("");
  const load = () => {
    setMd(null);
    api
      .report()
      .then((r) => {
        setMd(r.markdown);
        setFile(r.file);
      })
      .catch((e) => setErr(String(e.message ?? e)));
  };
  useEffect(load, []);
  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex items-center justify-between text-sm text-slate-400">
        <span>{file && <>Saved to <code className="text-slate-300">{file}</code>. Open the morning PR with <code className="text-amber-200">nightshift report --pr</code>.</>}</span>
        <button onClick={load} className="rounded-md border border-night-600 px-3 py-1 text-slate-200 hover:bg-night-800">
          Refresh
        </button>
      </div>
      {err && <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-red-200">{err}</div>}
      {md === null && !err && <div className="text-slate-500">Building report from git refs and the board…</div>}
      {md && <article className="rounded-xl border border-night-700 bg-night-900 p-6">{renderMarkdown(md)}</article>}
    </div>
  );
}

// Small renderer for the report's own markdown (headings, tables, lists, quotes, code, bold, inline code).
function inline(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g).map((p, i) => {
    if (p.startsWith("**")) return <strong key={i} className="text-white">{p.slice(2, -2)}</strong>;
    if (p.startsWith("`")) return <code key={i} className="rounded bg-night-800 px-1 text-amber-200">{p.slice(1, -1)}</code>;
    if (p.startsWith("_") && p.endsWith("_") && p.length > 2) return <em key={i} className="text-slate-400">{p.slice(1, -1)}</em>;
    return p;
  });
}

function renderMarkdown(md: string): ReactNode[] {
  const lines = md.split("\n");
  const out: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("```")) {
      const buf: string[] = [];
      while (++i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i]);
      out.push(<pre key={i} className="scroll-thin my-3 overflow-auto rounded-lg bg-night-950 p-3 font-mono text-xs text-slate-300">{buf.join("\n")}</pre>);
    } else if (l.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        if (!/^\|[-|\s]+\|$/.test(lines[i])) rows.push(lines[i].slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|")));
        i++;
      }
      i--;
      const [head, ...body] = rows;
      out.push(
        <div key={i} className="scroll-thin my-3 overflow-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>{head.map((h, j) => <th key={j} className="border-b border-night-700 px-2 py-1.5 font-medium text-slate-300">{h}</th>)}</tr>
            </thead>
            <tbody>
              {body.map((r, k) => (
                <tr key={k} className="border-b border-night-800">
                  {r.map((c, j) => <td key={j} className="px-2 py-1.5 align-top text-slate-300">{inline(c)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else if (l.startsWith("# ")) out.push(<h1 key={i} className="mb-3 text-2xl font-semibold text-white">{inline(l.slice(2))}</h1>);
    else if (l.startsWith("## ")) out.push(<h2 key={i} className="mb-2 mt-6 text-lg font-semibold text-white">{inline(l.slice(3))}</h2>);
    else if (l.startsWith("> ")) out.push(<blockquote key={i} className="my-3 border-l-2 border-amber-300/60 pl-3 text-amber-100/90">{inline(l.slice(2))}</blockquote>);
    else if (/^\s*- /.test(l)) out.push(<div key={i} className={`my-1 text-sm text-slate-300 ${l.startsWith("  ") ? "ml-8" : "ml-2"}`}>• {inline(l.replace(/^\s*- /, ""))}</div>);
    else if (l.trim()) out.push(<p key={i} className="my-2 text-sm text-slate-300">{inline(l)}</p>);
  }
  return out;
}
