import { useCallback, useEffect, useRef, useState } from "react";
import { api, AppState } from "./api";

import { Welcome } from "./Welcome";
import { SetupWizard } from "./Setup";
import { Tonight } from "./Tonight";
import { Morning } from "./Morning";

type Tab = "setup" | "tonight" | "morning";

export default function App() {
  const [app, setApp] = useState<AppState | null>(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<Tab | null>(null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const placedOnce = useRef(false);
  const [, force] = useState(0);
  useEffect(() => {
    // Re-measure once the tabs are in the DOM so the indicator starts in the right place.
    const t = setTimeout(() => force((n) => n + 1), 0);
    return () => clearTimeout(t);
  }, [tab, app?.project?.path]);

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
  const measured = tabRefs.current[current];
  const pill = measured ? { left: measured.offsetLeft, width: measured.offsetWidth } : null;
  // Only animate the pill once it has been placed; on first paint it appears in place.
  const animatePill = !!pill && placedOnce.current;
  if (pill) placedOnce.current = true;
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-night-700 bg-night-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-5 py-3 sm:px-8">
          <nav className="relative flex gap-1 text-[13px]">
            {pill && (
              <span
                aria-hidden
                className={`absolute inset-y-0 rounded-full bg-cream ${animatePill ? "transition-[left,width] duration-300 [transition-timing-function:cubic-bezier(.22,1,.36,1)]" : ""}`}
                style={{ left: pill.left, width: pill.width }}
              />
            )}
            {(["setup", "tonight", "morning"] as Tab[]).map((t) => (
              <button
                key={t}
                ref={(el) => {
                  tabRefs.current[t] = el;
                }}
                onClick={() => setTab(t)}
                className={`relative z-10 rounded-full px-3.5 py-1.5 capitalize transition-colors duration-300 ${current === t ? (pill ? "text-night-950" : "bg-cream text-night-950") : "text-neutral-400 hover:text-white"}`}
              >
                {t}
                {t === "tonight" && app.running && <span className="pulse-dot ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-indigo-300 align-middle" />}
              </button>
            ))}
          </nav>
          <button onClick={async () => (await api.close(), await reload(), setTab(null))} className="ml-auto text-[13px] text-neutral-500 hover:text-white">
            Switch project
          </button>
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
