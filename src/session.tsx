import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { INITIAL_MEMO, INITIAL_PLAN } from "./data/seed";
import { toISODate } from "./domain";

interface Session {
  date: string;
  memo: string;
  exercises: string[];
  finished: boolean;
  setMemo: (memo: string) => void;
  addExercise: (name: string) => void;
  finish: () => void;
  resume: () => void;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [date] = useState(() => toISODate(new Date()));
  const [memo, setMemoState] = useState(INITIAL_MEMO);
  const [exercises, setExercises] = useState<string[]>(INITIAL_PLAN);
  const [finished, setFinished] = useState(false);

  const value = useMemo<Session>(
    () => ({
      date,
      memo,
      exercises,
      finished,
      setMemo: (next) => setMemoState(next.replace(/[\r\n]/g, "")),
      addExercise: (name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        setExercises((current) => (current.includes(trimmed) ? current : [...current, trimmed]));
      },
      finish: () => setFinished(true),
      resume: () => setFinished(false),
    }),
    [date, memo, exercises, finished],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("セッションがありません");
  return session;
}
