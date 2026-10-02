import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { DayPlanClient } from "./data/dayPlanClient";
import { createDayPlanSaver } from "./data/dayPlanSync";
import { INITIAL_MEMO, INITIAL_PLAN } from "./data/seed";
import { toISODate } from "./domain";

interface Session {
  date: string;
  memo: string;
  exercises: string[];
  finished: boolean;
  /** 永続化に失敗したときだけ入る。モック経路では null */
  saveError: string | null;
  setMemo: (memo: string) => void;
  addExercise: (name: string) => void;
  finish: () => void;
  resume: () => void;
}

const SessionContext = createContext<Session | null>(null);

/** API 未設定のローカルはシード。DayPlan を読むときは空から始め、シードで上書きしない。 */
export function initialMenu(persistDayPlan: boolean): { memo: string; exercises: string[] } {
  if (persistDayPlan) return { memo: "", exercises: [] };
  return { memo: INITIAL_MEMO, exercises: [...INITIAL_PLAN] };
}

export function SessionProvider({
  children,
  dayPlan = null,
}: {
  children: ReactNode;
  dayPlan?: DayPlanClient | null;
}) {
  const [date] = useState(() => toISODate(new Date()));
  const seed = initialMenu(dayPlan != null);
  const [memo, setMemoState] = useState(seed.memo);
  const [exercises, setExercises] = useState<string[]>(seed.exercises);
  const [finished, setFinished] = useState(false);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">(dayPlan ? "loading" : "ready");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const saver = useMemo(
    () => (dayPlan ? createDayPlanSaver((input) => dayPlan.save(input).then(() => undefined)) : null),
    [dayPlan],
  );

  useEffect(() => {
    if (!saver) return;
    saver.setListeners({
      onError: (message) => setSaveError(message),
      onSaved: () => setSaveError(null),
    });
  }, [saver]);

  useEffect(() => {
    if (!dayPlan || !saver) return;
    let cancelled = false;
    setPhase("loading");
    dayPlan.load(date).then(
      (plan) => {
        if (cancelled) return;
        const next = {
          date,
          memo: plan.memo,
          exercises: [...plan.exercises],
          finished: plan.finished,
        };
        saver.markSaved(next);
        setMemoState(next.memo);
        setExercises(next.exercises);
        setFinished(next.finished);
        setSaveError(null);
        setPhase("ready");
      },
      (error: unknown) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : "メニューを読み込めませんでした");
        setPhase("error");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt, date, dayPlan, saver]);

  useEffect(() => {
    if (phase !== "ready" || !saver) return;
    saver.schedule({ date, memo, exercises, finished });
  }, [phase, saver, date, memo, exercises, finished]);

  useEffect(() => {
    if (!saver) return;
    const flush = () => {
      void saver.flush();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [saver]);

  const value = useMemo<Session>(() => {
    const publish = (next: { memo: string; exercises: string[]; finished: boolean }, immediate: boolean) => {
      if (!saver) return;
      saver.schedule({ date, ...next });
      if (immediate) void saver.flush();
    };
    return {
      date,
      memo,
      exercises,
      finished,
      saveError,
      setMemo: (next) => setMemoState(next.replace(/[\r\n]/g, "")),
      addExercise: (name) => {
        const trimmed = name.trim();
        if (!trimmed || exercises.includes(trimmed)) return;
        const next = [...exercises, trimmed];
        setExercises(next);
        publish({ memo, exercises: next, finished }, true);
      },
      finish: () => {
        setFinished(true);
        publish({ memo, exercises, finished: true }, true);
      },
      resume: () => {
        setFinished(false);
        publish({ memo, exercises, finished: false }, true);
      },
    };
  }, [date, exercises, finished, memo, saveError, saver]);

  if (phase === "loading") {
    return (
      <div className="app-shell">
        <section className="screen">
          <p className="status-line">メニューを読み込み中…</p>
        </section>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="app-shell">
        <section className="screen">
          <div className="status-line">
            <p className="text-error">{loadError}</p>
            <button type="button" className="btn secondary" onClick={() => setAttempt((current) => current + 1)}>
              再読み込み
            </button>
          </div>
        </section>
      </div>
    );
  }

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("セッションがありません");
  return session;
}
