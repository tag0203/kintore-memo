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
import type { WorkoutLogClient } from "./client";
import { assertCatalogName } from "./exerciseName";
import { logsOnDate, previousDayLogs } from "./logRows";
import type { MockSnapshot } from "./seed";

export function createMockClient(snapshot: MockSnapshot): WorkoutLogClient {
  const state: MockSnapshot = structuredClone(snapshot);

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
      const exercise = assertCatalogName(input.exercise);
      if (!isISODate(input.date)) throw new Error("日付が不正です");
      if (!isValidWeightKg(input.weightKg)) throw new Error("重量を確認してください");
      if (!isValidCount(input.reps)) throw new Error("回数を確認してください");
      if (!isValidCount(input.sets)) throw new Error("セット数を確認してください");
      if (!isDifficulty(input.difficulty)) throw new Error("きつさを選択してください");

      const createdAt = new Date().toISOString();
      const log: ExerciseLog = {
        id: `log_${crypto.randomUUID()}`,
        exercise,
        weightKg: Math.round(input.weightKg * 100) / 100,
        reps: input.reps,
        sets: input.sets,
        difficulty: input.difficulty,
        date: input.date,
        title: input.title?.trim() || PAGE_TITLE,
        createdAt,
      };
      state.logs.push(log);
      await this.touchExercise(exercise, createdAt);
      return { ...log };
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
