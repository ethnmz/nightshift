import { useEffect, useState, type ReactNode } from "react";
import { api, Snapshot } from "./api";
import { Button, Card, Copy, Input, Note, Skeleton, Title } from "./ui";

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
          <Title tag="Morning report" title="Good morning" sub="Everything the agents did, built from git and the team board. Read the decisions first, then open the pull request." />
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
      {md === null && !err && (
        <Card className="space-y-3">
          <Skeleton className="h-7 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-4/6" />
        </Card>
      )}
      <SubmissionKit />
      <Retries />
      {md && <Card>{renderMarkdown(md)}</Card>}
    </div>
  );
}

function inline(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g).map((p, i) => {
    if (p.startsWith("**")) return <strong key={i} className="font-medium text-cream">{p.slice(2, -2)}</strong>;
    if (p.startsWith("`")) return <code key={i} className="rounded-sm bg-night-800 px-1 font-mono text-[12px] text-cream">{p.slice(1, -1)}</code>;
    if (p.startsWith("_") && p.endsWith("_") && p.length > 2) return <em key={i} className="text-neutral-400">{p.slice(1, -1)}</em>;
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
      out.push(<pre key={i} className="my-3 overflow-auto rounded-md bg-night-950 p-3 font-mono text-xs text-neutral-300">{buf.join("\n")}</pre>);
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
              <tr>{head.map((h, j) => <th key={j} className="border-b border-white/10 px-2 py-1.5 font-medium text-neutral-300">{h}</th>)}</tr>
            </thead>
            <tbody>
              {body.map((r, k) => (
                <tr key={k} className="border-b border-night-700">
                  {r.map((c, j) => <td key={j} className="px-2 py-1.5 align-top text-neutral-300">{inline(c)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else if (l.startsWith("# ")) out.push(<h1 key={i} className="mb-3 text-2xl font-light text-cream">{inline(l.slice(2))}</h1>);
    else if (l.startsWith("## ")) out.push(<h2 key={i} className="mb-2 mt-8 border-t border-night-700 pt-6 text-lg font-light text-cream">{inline(l.slice(3))}</h2>);
    else if (l.startsWith("> ")) out.push(<blockquote key={i} className="my-3 border-l-2 border-copper pl-3 text-cream">{inline(l.slice(2))}</blockquote>);
    else if (/^\s*- /.test(l)) out.push(<div key={i} className={`my-1 text-sm text-neutral-300 ${l.startsWith("  ") ? "ml-8" : "ml-2"}`}>• {inline(l.replace(/^\s*- /, ""))}</div>);
    else if (l.trim()) out.push(<p key={i} className="my-2 text-sm text-neutral-300">{inline(l)}</p>);
  }
  return out;
}

/** README, demo script and Devpost draft from what actually got built. */
function SubmissionKit() {
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{ markdown: string; sections: { title: string; body: string }[] } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <div className="text-lg font-light text-cream">Submission kit</div>
          <p className="text-sm text-neutral-400">Your agent reads the finished code (read-only) and drafts how to run it, a demo script, what's real vs. mocked, and a Devpost write-up. Takes a few minutes.</p>
        </div>
        <Button
          busy={busy}
          onClick={async () => {
            setBusy(true);
            setMsg(null);
            try {
              setDraft(await api.draftSubmission());
            } catch (e) {
              setMsg({ ok: false, t: String((e as Error).message) });
            }
            setBusy(false);
          }}
        >
          {draft ? "Draft again" : "Draft README, demo and Devpost"}
        </Button>
      </div>
      {draft && (
        <div className="space-y-3">
          {draft.sections.map((s) => (
            <div key={s.title} className="rounded-md border border-night-700">
              <div className="flex items-center justify-between border-b border-night-700 px-4 py-2">
                <span className="text-sm text-cream">{s.title}</span>
                <Copy text={s.body} />
              </div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap px-4 py-3 text-[13px] leading-relaxed text-neutral-300">{s.body}</pre>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Copy text={draft.markdown} label="Copy everything" />
            <Button
              kind="soft"
              onClick={async () => {
                try {
                  const r = await api.commitSubmission(draft.markdown);
                  setMsg({ ok: true, t: r.sha === "unchanged" ? "SUBMISSION.md is already up to date." : "Added SUBMISSION.md to the night branch; it is part of the pull request." });
                } catch (e) {
                  setMsg({ ok: false, t: String((e as Error).message) });
                }
              }}
            >
              Add to the pull request
            </Button>
          </div>
        </div>
      )}
      {msg && <Note kind={msg.ok ? "ok" : "error"}>{msg.t}</Note>}
    </Card>
  );
}

/** Set-aside tasks: retry with a hint (runs in the next day shift or night). */
function Retries() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [hints, setHints] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Record<string, string>>({});
  useEffect(() => {
    api.snapshot().then(setSnap).catch(() => {});
  }, []);
  const parked = (snap?.tasks ?? []).filter((t) => t.readiness === "parked" && !snap!.tasks.some((x) => x.retry_of === (t.retry_of ?? t.id) && x.id !== t.id && x.readiness !== "parked"));
  if (!parked.length) return null;
  return (
    <Card className="space-y-3">
      <div>
        <div className="text-lg font-light text-cream">Set aside overnight</div>
        <p className="text-sm text-neutral-400">Add a hint and retry. Retries run in the next day shift (Tonight tab) or the next night.</p>
      </div>
      {parked.map((t) => (
        <div key={t.id} className="space-y-2 rounded-md border border-night-700 p-3">
          <div className="text-sm text-cream">
            {t.id} · {t.title}
          </div>
          {t.state?.note && <div className="text-xs text-neutral-500">Why: {t.state.note.slice(0, 300)}</div>}
          {done[t.id] ? (
            <div className="text-xs text-copper">{done[t.id]}</div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Input className="min-w-60 flex-1" placeholder="Hint, e.g. 'the test needs the dev server; mock fetch instead'" value={hints[t.id] ?? ""} onChange={(e) => setHints({ ...hints, [t.id]: e.target.value })} />
              <Button
                kind="soft"
                onClick={async () => {
                  try {
                    const r = await api.retry(t.id, hints[t.id] ?? "");
                    setDone({ ...done, [t.id]: `Queued as ${r.id}. Start a day shift on the Tonight tab to run it now.` });
                  } catch (e) {
                    setDone({ ...done, [t.id]: String((e as Error).message) });
                  }
                }}
              >
                Retry
              </Button>
            </div>
          )}
        </div>
      ))}
    </Card>
  );
}
