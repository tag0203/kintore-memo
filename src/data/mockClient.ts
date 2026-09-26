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
import type { MockSnapshot } from "./seed";

function compareDesc(left: ExerciseLog, right: ExerciseLog): number {
  if (left.date !== right.date) return left.date < right.date ? 1 : -1;
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
  return left.id < right.id ? 1 : -1;
}

function assertName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("種目名を入力してください");
  if (trimmed.length > 40) throw new Error("種目名は40文字以内にしてください");
  return trimmed;
}

export function createMockClient(snapshot: MockSnapshot): WorkoutLogClient {
  const state: MockSnapshot = structuredClone(snapshot);

  function latest(matches: ExerciseLog[]): ExerciseLog | null {
    return matches.sort(compareDesc)[0] ?? null;
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
      return latest(
        state.logs.filter((log) => log.exercise === exercise && log.date < beforeDate),
      );
    },

    async getLogOnDate(exercise, date) {
      return latest(state.logs.filter((log) => log.exercise === exercise && log.date === date));
    },

    async createLog(input: NewExerciseLog) {
      const exercise = assertName(input.exercise);
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
      const exerciseName = assertName(name);
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
