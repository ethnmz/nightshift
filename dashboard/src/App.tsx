import { useCallback, useEffect, useState } from "react";
import { api, AppState } from "./api";
import { Moon } from "./ui";
import { Welcome } from "./Welcome";
import { SetupWizard } from "./Setup";
import { Tonight } from "./Tonight";
import { Morning } from "./Morning";

type Tab = "setup" | "tonight" | "morning";

export default function App() {
  const [app, setApp] = useState<AppState | null>(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<Tab | null>(null);

  const reload = useCallback(async () => {
    try {
      const a = await api.app();
      setApp(a);
      setErr("");
      return a;
    } catch (e) {
      setErr(String((e as Error).message));
      return null;
    }
  }, []);

  useEffect(() => {
    void reload().then((a) => {
      if (!a?.project) return;
      // Open on Tonight once the night is running, or the board exists and this computer is set.
      setTab(a.running || (a.board?.issue && a.me && a.project.tasks) ? "tonight" : "setup");
    });
    const t = setInterval(() => void reload(), 5000);
    return () => clearInterval(t);
  }, [reload]);

  if (err && !app) return <div className="p-8 text-red-300">Cannot reach Nightshift: {err}. Is the Nightshift window still open?</div>;
  if (!app) return null;
  if (!app.project)
    return (
      <Welcome
        app={app}
        onOpened={async (t) => {
          await reload();
          setTab(t ?? "setup");
        }}
      />
    );

  const current = tab ?? "setup";
  const name = app.setup?.event.name || app.project.name;
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 bg-night-950/85 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3 sm:px-6">
          <button onClick={async () => (await api.close(), await reload(), setTab(null))} className="flex items-center gap-2" title="Switch project">
            <Moon className="h-5 w-5 text-amber-300" />
            <span className="max-w-[40vw] truncate font-semibold text-white">{name}</span>
          </button>
          <nav className="ml-auto flex gap-1 rounded-xl bg-night-900 p-1 text-sm">
            {(["setup", "tonight", "morning"] as Tab[]).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`rounded-lg px-3 py-1.5 capitalize transition sm:px-4 ${current === t ? "bg-night-700 text-white" : "text-slate-400 hover:text-slate-200"}`}>
                {t}
                {t === "tonight" && app.running && <span className="pulse-dot ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-indigo-300 align-middle" />}
              </button>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 pb-16 pt-4 sm:px-6">
        {current === "setup" && <SetupWizard app={app} reload={reload} goTonight={() => setTab("tonight")} />}
        {current === "tonight" && <Tonight app={app} reload={reload} />}
        {current === "morning" && <Morning />}
      </main>
    </div>
  );
}
