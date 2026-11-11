import { useEffect, useState, type ReactNode } from "react";
import { api } from "./api";
import { Button, Card, Note } from "./ui";

export function Morning() {
  const [md, setMd] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [pr, setPr] = useState<{ ok: boolean; t: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.report().then((r) => setMd(r.markdown)).catch((e) => setErr(String(e.message)));
  }, []);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <h2 className="text-xl font-semibold text-white">Good morning</h2>
          <p className="text-sm text-slate-400">Everything the agents did, built from git and the team board. Read the decisions first, then open the pull request.</p>
        </div>
        <Button
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api.openPr();
              setPr({ ok: true, t: r.url });
            } catch (e) {
              setPr({ ok: false, t: String((e as Error).message) });
            }
            setBusy(false);
          }}
        >
          Open the pull request
        </Button>
      </div>
      {pr && (
        <Note kind={pr.ok ? "ok" : "error"}>
          {pr.ok ? (
            <a href={pr.t} target="_blank" rel="noreferrer" className="underline">
              {pr.t}
            </a>
          ) : (
            pr.t
          )}
        </Note>
      )}
      {err && <Note kind="error">{err}</Note>}
      {md === null && !err && <div className="text-slate-500">Building the report…</div>}
      {md && <Card>{renderMarkdown(md)}</Card>}
    </div>
  );
}

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
      out.push(<pre key={i} className="my-3 overflow-auto rounded-xl bg-night-950 p-3 font-mono text-xs text-slate-300">{buf.join("\n")}</pre>);
    } else if (l.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        if (!/^\|[-|\s]+\|$/.test(lines[i])) rows.push(lines[i].slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|")));
        i++;
      }
      i--;
      const [head, ...body] = rows;
      out.push(
        <div key={i} className="my-3 overflow-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>{head.map((h, j) => <th key={j} className="border-b border-white/10 px-2 py-1.5 font-medium text-slate-300">{h}</th>)}</tr>
            </thead>
            <tbody>
              {body.map((r, k) => (
                <tr key={k} className="border-b border-white/5">
                  {r.map((c, j) => <td key={j} className="px-2 py-1.5 align-top text-slate-300">{inline(c)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else if (l.startsWith("# ")) out.push(<h1 key={i} className="mb-3 text-xl font-semibold text-white">{inline(l.slice(2))}</h1>);
    else if (l.startsWith("## ")) out.push(<h2 key={i} className="mb-2 mt-6 text-base font-semibold text-white">{inline(l.slice(3))}</h2>);
    else if (l.startsWith("> ")) out.push(<blockquote key={i} className="my-3 border-l-2 border-amber-300/60 pl-3 text-amber-100/90">{inline(l.slice(2))}</blockquote>);
    else if (/^\s*- /.test(l)) out.push(<div key={i} className={`my-1 text-sm text-slate-300 ${l.startsWith("  ") ? "ml-8" : "ml-2"}`}>• {inline(l.replace(/^\s*- /, ""))}</div>);
    else if (l.trim()) out.push(<p key={i} className="my-2 text-sm text-slate-300">{inline(l)}</p>);
  }
  return out;
}
