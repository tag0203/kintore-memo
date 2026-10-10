import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "./auth/AuthContext";
import { DAY_PLAN_EXERCISE_LIMIT, DAY_PLAN_TOO_MANY_EXERCISES, type DayPlanClient } from "./data/dayPlanClient";
import {
  DAY_PLAN_EXERCISE_INVALID,
  DAY_PLAN_EXERCISE_TOO_LONG,
  dayPlanExerciseNameIssue,
} from "./data/exerciseName";
import { createDayPlanSaver } from "./data/dayPlanSync";
import { INITIAL_MEMO, INITIAL_PLAN } from "./data/seed";
import {
  isWritableSessionDate,
  menuFromDayPlan,
  readStoredSessionDate,
  recallMenu,
  resolveStoredSessionDate,
  storeMenu,
  switchSessionDate,
  writeStoredSessionDate,
  type SessionDateStorage,
  type SessionMenu,
} from "./sessionDate";

export type AddExerciseResult = "added" | "present" | "empty" | "too_many" | "invalid" | "too_long";

/** removed: メニューから外した。absent: その名前は無い。finished: 今日を終了済みなので外さない。 */
export type RemoveExerciseResult = "removed" | "absent" | "finished";

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

/**
 * 今日のメニューから種目を1つ外したあとの配列。
 * Notion の記録行は触らない。呼び出し側が DayPlan の exercises をまるごと保存する。
 * 「今日を終了」（finished）のあとは再開するまで外さない。配列も保存も変えない。
 */
export function withoutExercise(
  exercises: readonly string[],
  name: string,
  finished: boolean,
): { result: RemoveExerciseResult; exercises: string[] } {
  if (finished) return { result: "finished", exercises: [...exercises] };
  const trimmed = name.trim();
  if (!trimmed || !exercises.includes(trimmed)) return { result: "absent", exercises: [...exercises] };
  return { result: "removed", exercises: exercises.filter((item) => item !== trimmed) };
}

/** removed のときだけ保存するスナップショットを返す。finished と absent は保存しない。 */
export function removalSnapshot(
  menu: { memo: string; exercises: readonly string[]; finished: boolean },
  name: string,
): { result: RemoveExerciseResult; menu: { memo: string; exercises: string[]; finished: boolean } | null } {
  const decision = withoutExercise(menu.exercises, name, menu.finished);
  if (decision.result !== "removed") return { result: decision.result, menu: null };
  return {
    result: "removed",
    menu: { memo: menu.memo, exercises: decision.exercises, finished: menu.finished },
  };
}

interface Session {
  date: string;
  /** 保存していた日付が窓の外だったときだけ入る */
  dateNotice: string | null;
  memo: string;
  exercises: string[];
  finished: boolean;
  /** 永続化に失敗したときだけ入る。モック経路では null */
  saveError: string | null;
  /** 東京の前日・当日・翌日だけ。切り替える前に、入力途中の DayPlan を flush する。 */
  setDate: (date: string) => Promise<void>;
  dismissDateNotice: () => void;
  setMemo: (memo: string) => void;
  addExercise: (name: string) => AddExerciseResult;
  /**
   * 今日のメニューから種目を外し、追加と同じく publish → saver で exercises 全体を保存する。
   * finished のあいだは外さない（再開するまで）。Notion の記録は削除しない。
   */
  removeExercise: (name: string) => RemoveExerciseResult;
  finish: () => void;
  resume: () => void;
}

const SessionContext = createContext<Session | null>(null);

const defaultDateStorage: SessionDateStorage = {
  getItem(key) {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    globalThis.localStorage?.setItem(key, value);
  },
};

/** API 未設定のローカルはシード。DayPlan を読むときは空から始め、シードで上書きしない。 */
export function initialMenu(persistDayPlan: boolean): { memo: string; exercises: string[] } {
  if (persistDayPlan) return { memo: "", exercises: [] };
  return { memo: INITIAL_MEMO, exercises: [...INITIAL_PLAN] };
}

export function SessionProvider({
  children,
  dayPlan = null,
  now = () => new Date(),
  dateStorage = defaultDateStorage,
}: {
  children: ReactNode;
  dayPlan?: DayPlanClient | null;
  /** テストから東京の「いま」を渡す。画面は `new Date()`。 */
  now?: () => Date;
  dateStorage?: SessionDateStorage;
}) {
  const [boot] = useState(() => resolveStoredSessionDate(readStoredSessionDate(dateStorage), now()));
  const [date, setDateState] = useState(boot.date);
  const [dateNotice, setDateNotice] = useState<string | null>(boot.notice);
  const seed = initialMenu(dayPlan != null);
  const [memo, setMemoState] = useState(seed.memo);
  const [exercises, setExercises] = useState<string[]>(seed.exercises);
  const [finished, setFinished] = useState(false);
  /** DayPlan を読むあいだは null。モックは選んだ日付のメニューが state に入っている。 */
  const [menuDate, setMenuDate] = useState<string | null>(dayPlan ? null : boot.date);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">(dayPlan ? "loading" : "ready");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { registerBeforeSignOut, readSessionEpoch, required, signOut } = useAuth();
  const dateRef = useRef(date);
  dateRef.current = date;
  const menuRef = useRef<SessionMenu>({ memo, exercises, finished });
  menuRef.current = { memo, exercises, finished };
  const localMenus = useRef(new Map<string, SessionMenu>());
  const switching = useRef(false);
  const nowRef = useRef(now);
  nowRef.current = now;

  const saver = useMemo(() => {
    if (!dayPlan) return null;
    const epoch = readSessionEpoch();
    return createDayPlanSaver((input) => dayPlan.save(input).then(() => undefined), {
      allowWrite: () => readSessionEpoch() === epoch,
    });
  }, [dayPlan, readSessionEpoch]);

  const saverRef = useRef(saver);
  saverRef.current = saver;

  useEffect(() => {
    if (!boot.notice) return;
    writeStoredSessionDate(dateStorage, boot.date);
  }, [boot.date, boot.notice, dateStorage]);

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
        const nextMenu = menuFromDayPlan(plan);
        saver.markSaved({ date, ...nextMenu });
        setMemoState(nextMenu.memo);
        setExercises(nextMenu.exercises);
        setFinished(nextMenu.finished);
        setMenuDate(date);
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
    if (phase !== "ready" || !saver || menuDate !== date) return;
    saver.schedule({ date, memo, exercises, finished });
  }, [phase, saver, date, memo, exercises, finished, menuDate]);

  const setDate = useCallback(
    async (next: string) => {
      if (switching.current || next === dateRef.current) return;
      if (!isWritableSessionDate(next, nowRef.current())) return;
      const previous = dateRef.current;
      switching.current = true;
      try {
        const result = await switchSessionDate({
          currentDate: previous,
          nextDate: next,
          now: nowRef.current(),
          flush: () => saverRef.current?.flush() ?? Promise.resolve(),
          persist: (value) => writeStoredSessionDate(dateStorage, value),
        });
        if (!result.switched) return;
        // flush の通信中に入った変更を、日付を変える前にもう一度送る。
        await saverRef.current?.flush();
        setDateNotice(null);
        if (dayPlan) {
          // 読み込みが終わるまで、前のメニューを新しい日付へ保存しない。
          setMenuDate(null);
          setPhase("loading");
          dateRef.current = result.date;
          setDateState(result.date);
          return;
        }
        storeMenu(localMenus.current, previous, menuRef.current);
        const restored = recallMenu(localMenus.current, result.date);
        menuRef.current = restored;
        dateRef.current = result.date;
        setMemoState(restored.memo);
        setExercises(restored.exercises);
        setFinished(restored.finished);
        setMenuDate(result.date);
        setDateState(result.date);
      } finally {
        switching.current = false;
      }
    },
    [dateStorage, dayPlan],
  );

  const dismissDateNotice = useCallback(() => setDateNotice(null), []);

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
      if (!saver || menuDate !== date) return;
      saver.schedule({ date, ...next });
      if (immediate) void saver.flush();
    };
    return {
      date,
      dateNotice,
      dismissDateNotice,
      setDate,
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
      removeExercise: (name) => {
        const decision = removalSnapshot({ memo, exercises, finished }, name);
        if (!decision.menu) return decision.result;
        setExercises(decision.menu.exercises);
        publish(decision.menu, true);
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
  }, [date, dateNotice, dismissDateNotice, exercises, finished, memo, menuDate, saveError, saver, setDate]);

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
