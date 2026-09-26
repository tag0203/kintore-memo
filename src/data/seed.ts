import {
  addDays,
  toISODate,
  type Difficulty,
  type ExerciseLog,
  type ExerciseSummary,
} from "../domain";

export interface MockSnapshot {
  exercises: ExerciseSummary[];
  logs: ExerciseLog[];
}

export const INITIAL_MEMO = "脚";
export const INITIAL_PLAN = ["スクワット", "レッグプレス", "レッグカール"];

function at(day: string, time: string): string {
  return `${day}T${time}:00.000Z`;
}

function makeLog(
  id: string,
  exercise: string,
  weightKg: number,
  reps: number,
  sets: number,
  difficulty: Difficulty,
  date: string,
  createdAt: string,
): ExerciseLog {
  return {
    id,
    exercise,
    weightKg,
    reps,
    sets,
    difficulty,
    date,
    title: "－",
    createdAt,
  };
}

/** 画面モックに合わせた初期データ。日付は起動日からの相対。 */
export function createSeed(now = new Date()): MockSnapshot {
  const today = toISODate(now);
  const yesterday = addDays(today, -1);
  const threeDaysAgo = addDays(today, -3);
  const sixDaysAgo = addDays(today, -6);

  const exercises: ExerciseSummary[] = [
    { name: "スクワット", lastPickedAt: at(yesterday, "12:00") },
    { name: "レッグプレス", lastPickedAt: at(yesterday, "11:00") },
    { name: "レッグカール", lastPickedAt: at(sixDaysAgo, "09:00") },
    { name: "レッグエクステンション", lastPickedAt: null },
    { name: "ベンチプレス", lastPickedAt: at(threeDaysAgo, "10:00") },
    { name: "ラットプルダウン", lastPickedAt: null },
  ];

  const logs: ExerciseLog[] = [
    makeLog("seed-squat", "スクワット", 80, 11, 3, 3, yesterday, at(yesterday, "12:10")),
    makeLog("seed-press", "レッグプレス", 150, 10, 3, 3, yesterday, at(yesterday, "11:10")),
    makeLog("seed-curl-old", "レッグカール", 40, 12, 3, 2, sixDaysAgo, at(sixDaysAgo, "09:10")),
    makeLog("seed-curl-today", "レッグカール", 40, 12, 3, 2, today, at(today, "08:10")),
    makeLog("seed-bench", "ベンチプレス", 60, 8, 3, 4, threeDaysAgo, at(threeDaysAgo, "10:10")),
  ];

  return { exercises, logs };
}
