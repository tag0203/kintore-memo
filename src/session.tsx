import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "./auth/AuthContext";
import { DAY_PLAN_EXERCISE_LIMIT, DAY_PLAN_TOO_MANY_EXERCISES, type DayPlanClient } from "./data/dayPlanClient";
import {
  DAY_PLAN_EXERCISE_INVALID,
  DAY_PLAN_EXERCISE_TOO_LONG,
  dayPlanExerciseNameIssue,
} from "./data/exerciseName";
import { createDayPlanSaver } from "./data/dayPlanSync";
import { INITIAL_MEMO, INITIAL_PLAN } from "./data/seed";
import { toISODate } from "./domain";

export type AddExerciseResult = "added" | "present" | "empty" | "too_many" | "invalid" | "too_long";

/** `limit` が null のときはモック経路。永続化するときは DayPlan の 40 件で止める。名前の禁止文字はどちらも拒否する。 */
export function nextExerciseList(
  exercises: readonly string[],
  name: string,
  limit: number | null,
): { result: AddExerciseResult; exercises: string[] } {
  const trimmed = name.trim();
  if (!trimmed) return { result: "empty", exercises: [...exercises] };
  if (exercises.includes(trimmed)) return { result: "present", exercises: [...exercises] };
  const issue = dayPlanExerciseNameIssue(trimmed);
  if (issue) return { result: issue, exercises: [...exercises] };
  if (limit != null && exercises.length >= limit) return { result: "too_many", exercises: [...exercises] };
  return { result: "added", exercises: [...exercises, trimmed] };
}

interface Session {
  date: string;
  memo: string;
  exercises: string[];
  finished: boolean;
  /** 永続化に失敗したときだけ入る。モック経路では null */
  saveError: string | null;
  setMemo: (memo: string) => void;
  addExercise: (name: string) => AddExerciseResult;
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
  const { registerBeforeSignOut, readSessionEpoch, required, signOut } = useAuth();

  const saver = useMemo(() => {
    if (!dayPlan) return null;
    const epoch = readSessionEpoch();
    return createDayPlanSaver((input) => dayPlan.save(input).then(() => undefined), {
      allowWrite: () => readSessionEpoch() === epoch,
    });
  }, [dayPlan, readSessionEpoch]);

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
      saver.cancel();
    };
  }, [saver]);

  useEffect(() => {
    if (!saver) return;
    return registerBeforeSignOut(() => saver.flush());
  }, [registerBeforeSignOut, saver]);

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
        const decision = nextExerciseList(exercises, name, saver ? DAY_PLAN_EXERCISE_LIMIT : null);
        if (decision.result === "too_many") {
          setSaveError(DAY_PLAN_TOO_MANY_EXERCISES);
          return decision.result;
        }
        if (decision.result === "invalid") {
          setSaveError(DAY_PLAN_EXERCISE_INVALID);
          return decision.result;
        }
        if (decision.result === "too_long") {
          setSaveError(DAY_PLAN_EXERCISE_TOO_LONG);
          return decision.result;
        }
        if (decision.result !== "added") return decision.result;
        setExercises(decision.exercises);
        publish({ memo, exercises: decision.exercises, finished }, true);
        return decision.result;
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
      <DayPlanLoadFailure
        message={loadError ?? "メニューを読み込めませんでした"}
        onRetry={() => setAttempt((current) => current + 1)}
        onSignOut={required ? () => void signOut() : null}
      />
    );
  }

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function DayPlanLoadFailure({
  message,
  onRetry,
  onSignOut,
}: {
  message: string;
  onRetry: () => void;
  onSignOut: (() => void) | null;
}) {
  return (
    <div className="app-shell">
      <section className="screen">
        {onSignOut && (
          <div className="today-head">
            <span />
            <button type="button" className="text-btn" onClick={onSignOut}>
              ログアウト
            </button>
          </div>
        )}
        <div className="status-line">
          <p className="text-error">{message}</p>
          <button type="button" className="btn secondary" onClick={onRetry}>
            再読み込み
          </button>
        </div>
      </section>
    </div>
  );
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("セッションがありません");
  return session;
}
