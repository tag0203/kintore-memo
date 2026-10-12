import {
  PAGE_TITLE,
  isDifficulty,
  isISODate,
  isValidCount,
  isValidWeightKg,
  type ExerciseLog,
  type ExerciseSummary,
  type NewExerciseLog,
} from "../domain";
import type { DayFlushStatus, WorkoutLogClient } from "./client";
import { assertCatalogName } from "./exerciseName";
import { logsOnDate, previousDayLogs } from "./logRows";
import type { MockSnapshot } from "./seed";

const CLOSED_DAY = "反映済みの記録は Notion で修正してください";

export function createMockClient(snapshot: MockSnapshot): WorkoutLogClient {
  const state: MockSnapshot = structuredClone(snapshot);
    const closed = new Set<string>();
    const statuses = new Map<string, DayFlushStatus>();

  function assertDraft(log: ExerciseLog | undefined): ExerciseLog {
    if (!log) throw new Error("見つかりません");
    if (log.synced !== false || closed.has(log.date)) throw new Error(CLOSED_DAY);
    return log;
  }

  function readInput(input: NewExerciseLog) {
    const exercise = assertCatalogName(input.exercise);
    if (!isISODate(input.date)) throw new Error("日付が不正です");
    if (!isValidWeightKg(input.weightKg)) throw new Error("重量を確認してください");
    if (!isValidCount(input.reps)) throw new Error("回数を確認してください");
    if (!isValidCount(input.sets)) throw new Error("セット数を確認してください");
    if (!isDifficulty(input.difficulty)) throw new Error("きつさを選択してください");
    return {
      exercise,
      weightKg: Math.round(input.weightKg * 100) / 100,
      reps: input.reps,
      sets: input.sets,
      difficulty: input.difficulty,
      date: input.date,
      title: input.title?.trim() || PAGE_TITLE,
    };
  }

  return {
    async listExercises() {
      return state.exercises.map((exercise) => ({ ...exercise }));
    },

    async listRecentExercises() {
      return state.exercises
        .filter((exercise) => exercise.lastPickedAt)
        .slice()
        .sort((left, right) => (left.lastPickedAt! < right.lastPickedAt! ? 1 : -1))
        .map((exercise) => ({ ...exercise }));
    },

    async getPreviousLog(exercise, beforeDate) {
      return previousDayLogs(state.logs, exercise, beforeDate).map((log) => ({ ...log }));
    },

    async getLogOnDate(exercise, date) {
      return logsOnDate(state.logs, exercise, date).map((log) => ({ ...log }));
    },

    async createLog(input: NewExerciseLog) {
      const fields = readInput(input);
      if (closed.has(fields.date)) throw new Error(CLOSED_DAY);
      const createdAt = new Date().toISOString();
      const log: ExerciseLog = { id: `log_${crypto.randomUUID()}`, ...fields, createdAt, synced: false };
      state.logs.push(log);
      await this.touchExercise(fields.exercise, createdAt);
      return { ...log };
    },

    async updateLog(id: string, input: NewExerciseLog) {
      const current = assertDraft(state.logs.find((log) => log.id === id));
      const fields = readInput(input);
      if (fields.date !== current.date || fields.exercise !== current.exercise) {
        throw new Error("日付を確認してください");
      }
      const next: ExerciseLog = { ...current, ...fields, synced: false };
      state.logs[state.logs.indexOf(current)] = next;
      return { ...next };
    },

    async deleteLog(id: string) {
      const current = assertDraft(state.logs.find((log) => log.id === id));
      state.logs = state.logs.filter((log) => log.id !== current.id);
    },

    async finishDay(date: string) {
      if (!isISODate(date)) throw new Error("日付が不正です");
      closed.add(date);
      statuses.set(date, "synced");
      for (const log of state.logs) {
        if (log.date === date && log.synced === false) log.synced = true;
      }
      return "synced" as const;
    },

    async refreshDayStatus(date: string) {
      return statuses.get(date) ?? (closed.has(date) ? "synced" : "open");
    },

    dayStatus(date: string) {
      return statuses.get(date) ?? (closed.has(date) ? "synced" : "open");
    },

    isDayClosed(date: string) {
      const status = statuses.get(date);
      return status === "synced" || status === "flushing" || closed.has(date);
    },

    async touchExercise(name: string, atISO: string) {
      const exerciseName = assertCatalogName(name);
      const existing = state.exercises.find((exercise) => exercise.name === exerciseName);
      if (existing) {
        existing.lastPickedAt = atISO;
        return { ...existing };
      }
      const created: ExerciseSummary = { name: exerciseName, lastPickedAt: atISO };
      state.exercises.push(created);
      return { ...created };
    },
  };
}
