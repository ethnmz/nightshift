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
      <header className="sticky top-0 z-20 border-b border-night-700 bg-night-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-5 py-3 sm:px-8">
          <button onClick={async () => (await api.close(), await reload(), setTab(null))} className="flex items-center gap-2" title="Switch project">
            <Moon className="h-5 w-5 text-cream" />
            <span className="max-w-[40vw] truncate font-medium text-cream">{name}</span>
          </button>
          <nav className="ml-auto flex gap-1 text-[13px]">
            {(["setup", "tonight", "morning"] as Tab[]).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`rounded-full px-3.5 py-1.5 capitalize transition ${current === t ? "bg-cream text-night-950" : "text-neutral-400 hover:text-white"}`}>
                {t}
                {t === "tonight" && app.running && <span className="pulse-dot ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-indigo-300 align-middle" />}
              </button>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-5 pb-20 pt-8 sm:px-8">
        {current === "setup" && <SetupWizard app={app} reload={reload} goTonight={() => setTab("tonight")} />}
        {current === "tonight" && <Tonight app={app} reload={reload} />}
        {current === "morning" && <Morning />}
      </main>
    </div>
  );
}
