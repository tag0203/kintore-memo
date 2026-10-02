import { apiUrl, authorizedFetch } from "../auth/authorizedFetch";
import { isDifficulty, toISODate, type ExerciseLog, type ExerciseSummary, type NewExerciseLog } from "../domain";
import type { WorkoutLogClient } from "./client";

/**
 * API Gateway 向けの WorkoutLogClient。
 * Authorization は Cognito の IdToken だけ。Notion のトークンは送らない。
 *
 * セッション開始で GET /api/bootstrap を一括取得し、種目・前回・当日はメモリに置く。
 * 画面遷移の読み取りはキャッシュだけ。API を再呼び出しするのは保存（POST /api/logs）で、
 * 成功した行でキャッシュを更新する。個別の GET /api/logs/* は呼ばない。
 *
 * Lambda の bootstrap は種目 40 件まで。それを超える分は起動時の続きの一括取得に分ける。
 */

const BOOTSTRAP_LIMIT = 40;

interface LogPair {
  previous: ExerciseLog | null;
  today: ExerciseLog | null;
}

interface SessionCache {
  date: string;
  exercises: ExerciseSummary[];
  logs: Map<string, LogPair>;
  catalogReady: boolean;
}

export interface HttpWorkoutClientOptions {
  apiBaseUrl: string;
  getIdToken: () => Promise<string>;
  /** listExercises が日付より先に来たときのセッション日。画面は起動日を渡す。 */
  now?: Date;
}

function assertName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("種目名を入力してください");
  if (trimmed.length > 40) throw new Error("種目名は40文字以内にしてください");
  return trimmed;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function messageFrom(payload: unknown, status: number, fallback: string): string {
  if (isRecord(payload)) {
    if (typeof payload.error === "string" && payload.error.trim()) return payload.error;
    if (typeof payload.message === "string" && payload.message.trim()) return payload.message;
  }
  return `${fallback}（${status}）`;
}

function parseLog(value: unknown): ExerciseLog {
  if (!isRecord(value)) throw new Error("記録の取得に失敗しました");
  const difficulty = value.difficulty;
  if (
    typeof value.id !== "string" ||
    typeof value.exercise !== "string" ||
    typeof value.weightKg !== "number" ||
    typeof value.reps !== "number" ||
    typeof value.sets !== "number" ||
    typeof difficulty !== "number" ||
    !isDifficulty(difficulty) ||
    typeof value.date !== "string" ||
    typeof value.title !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    throw new Error("記録の取得に失敗しました");
  }
  return {
    id: value.id,
    exercise: value.exercise,
    weightKg: value.weightKg,
    reps: value.reps,
    sets: value.sets,
    difficulty,
    date: value.date,
    title: value.title,
    createdAt: value.createdAt,
  };
}

function parseLogOrNull(value: unknown): ExerciseLog | null {
  if (value == null) return null;
  return parseLog(value);
}

function parseSummary(value: unknown): ExerciseSummary {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim()) {
    throw new Error("記録の取得に失敗しました");
  }
  if (value.lastPickedAt != null && typeof value.lastPickedAt !== "string") {
    throw new Error("記録の取得に失敗しました");
  }
  return { name: value.name, lastPickedAt: value.lastPickedAt ?? null };
}

function parseBootstrap(payload: unknown): {
  exercises: ExerciseSummary[];
  recent: ExerciseSummary[];
  logs: Map<string, LogPair>;
} {
  if (!isRecord(payload) || !Array.isArray(payload.exercises) || !Array.isArray(payload.recent) || !isRecord(payload.logs)) {
    throw new Error("記録の取得に失敗しました");
  }
  const logs = new Map<string, LogPair>();
  for (const [name, pair] of Object.entries(payload.logs)) {
    if (!isRecord(pair)) throw new Error("記録の取得に失敗しました");
    logs.set(name, { previous: parseLogOrNull(pair.previous), today: parseLogOrNull(pair.today) });
  }
  return {
    exercises: payload.exercises.map(parseSummary),
    recent: payload.recent.map(parseSummary),
    logs,
  };
}

function mergeSummaries(exercises: ExerciseSummary[], recent: ExerciseSummary[]): ExerciseSummary[] {
  const byName = new Map<string, ExerciseSummary>();
  for (const exercise of exercises) byName.set(exercise.name, { ...exercise });
  for (const exercise of recent) {
    const existing = byName.get(exercise.name);
    if (!existing) {
      byName.set(exercise.name, { ...exercise });
      continue;
    }
    if (exercise.lastPickedAt && (!existing.lastPickedAt || exercise.lastPickedAt > existing.lastPickedAt)) {
      existing.lastPickedAt = exercise.lastPickedAt;
    }
  }
  return [...byName.values()];
}

function copyLog(log: ExerciseLog | null): ExerciseLog | null {
  return log ? { ...log } : null;
}

export function createHttpWorkoutClient(options: HttpWorkoutClientOptions): WorkoutLogClient {
  const apiBaseUrl = options.apiBaseUrl.trim().replace(/\/+$/, "");
  if (!apiBaseUrl) throw new Error("API のベース URL がありません");
  const getIdToken = options.getIdToken;
  const now = options.now ?? new Date();

  let cache: SessionCache | null = null;
  let pending = new Set<string>();
  let scheduledDate: string | null = null;
  let scheduled: Promise<void> | null = null;

  async function request(path: string, init: RequestInit | undefined, fallback: string): Promise<unknown> {
    const response = await authorizedFetch(apiUrl(apiBaseUrl, path), init, getIdToken);
    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        throw new Error(response.ok ? "記録の取得に失敗しました" : messageFrom(null, response.status, fallback));
      }
    }
    if (!response.ok) throw new Error(messageFrom(payload, response.status, fallback));
    return payload;
  }

  function bootstrapPath(date: string, names: readonly string[]): string {
    const params = new URLSearchParams();
    params.set("date", date);
    for (const name of names) params.append("exercise", name);
    return `/api/bootstrap?${params.toString()}`;
  }

  async function pull(date: string, names: readonly string[]): Promise<void> {
    const payload = await request(bootstrapPath(date, names), { method: "GET" }, "記録の取得に失敗しました");
    const parsed = parseBootstrap(payload);
    if (!cache || cache.date !== date) {
      cache = { date, exercises: [], logs: new Map(), catalogReady: false };
    }
    cache.exercises = mergeSummaries(parsed.exercises, parsed.recent);
    for (const [name, pair] of parsed.logs) cache.logs.set(name, pair);
    for (const name of names) {
      if (!cache.logs.has(name)) cache.logs.set(name, { previous: null, today: null });
    }
  }

  async function load(date: string, names: readonly string[]): Promise<void> {
    if (cache && cache.date !== date) cache = null;
    const missing = names.filter((name) => !cache?.logs.has(name));
    if (!cache?.catalogReady) {
      if (missing.length === 0) await pull(date, []);
      else {
        for (const chunk of chunks(missing, BOOTSTRAP_LIMIT)) await pull(date, chunk);
      }
      const extras = (cache?.exercises ?? [])
        .map((exercise) => exercise.name)
        .filter((name) => !cache?.logs.has(name));
      for (const chunk of chunks(extras, BOOTSTRAP_LIMIT)) await pull(date, chunk);
      if (cache) cache.catalogReady = true;
      return;
    }
    for (const chunk of chunks(missing, BOOTSTRAP_LIMIT)) await pull(date, chunk);
  }

  async function fillPending(): Promise<void> {
    const date = scheduledDate;
    if (!date) return;
    const names = [...pending];
    pending = new Set();
    await load(date, names);
    if (scheduledDate === date && (pending.size > 0 || (cache != null && !cache.catalogReady))) {
      await fillPending();
    }
  }

  function isReady(date: string, names: readonly string[]): boolean {
    if (!cache || cache.date !== date || !cache.catalogReady) return false;
    return names.every((name) => cache?.logs.has(name));
  }

  function need(date: string, names: readonly string[]): Promise<void> {
    if (isReady(date, names)) return Promise.resolve();
    if (scheduled && scheduledDate && scheduledDate !== date) {
      return scheduled.then(() => need(date, names));
    }
    for (const name of names) pending.add(name);
    scheduledDate = date;
    if (!scheduled) {
      scheduled = Promise.resolve()
        .then(() => fillPending())
        .finally(() => {
          scheduled = null;
        });
    }
    const wait = scheduled;
    return wait.then(() => {
      if (isReady(date, names)) return;
      return need(date, names);
    });
  }

  function requireCache(date: string): SessionCache {
    if (!cache || cache.date !== date) throw new Error("記録の取得に失敗しました");
    return cache;
  }

  function upsertExercise(name: string, atISO: string): ExerciseSummary {
    if (!cache) throw new Error("記録の取得に失敗しました");
    const existing = cache.exercises.find((exercise) => exercise.name === name);
    if (existing) {
      existing.lastPickedAt = atISO;
      return { ...existing };
    }
    const created: ExerciseSummary = { name, lastPickedAt: atISO };
    cache.exercises.push(created);
    return { ...created };
  }

  function remember(log: ExerciseLog): void {
    if (!cache || cache.date !== log.date) return;
    const current = cache.logs.get(log.exercise) ?? { previous: null, today: null };
    const today = current.today;
    const newer =
      !today || log.createdAt > today.createdAt || (log.createdAt === today.createdAt && log.id >= today.id);
    cache.logs.set(log.exercise, { previous: current.previous, today: newer ? log : today });
    upsertExercise(log.exercise, log.createdAt);
  }

  function namesFor(date: string, exercise: string): string[] {
    if (cache?.catalogReady && cache.date === date) return [];
    return [exercise];
  }

  return {
    async listExercises() {
      const date = cache?.date ?? toISODate(now);
      await need(date, []);
      return requireCache(date).exercises.map((exercise) => ({ ...exercise }));
    },

    async listRecentExercises() {
      const date = cache?.date ?? toISODate(now);
      await need(date, []);
      return requireCache(date)
        .exercises.filter((exercise) => exercise.lastPickedAt)
        .slice()
        .sort((left, right) => (left.lastPickedAt! < right.lastPickedAt! ? 1 : -1))
        .map((exercise) => ({ ...exercise }));
    },

    async getPreviousLog(exercise, beforeDate) {
      await need(beforeDate, namesFor(beforeDate, exercise));
      return copyLog(requireCache(beforeDate).logs.get(exercise)?.previous ?? null);
    },

    async getLogOnDate(exercise, date) {
      await need(date, namesFor(date, exercise));
      return copyLog(requireCache(date).logs.get(exercise)?.today ?? null);
    },

    async createLog(input: NewExerciseLog) {
      await need(input.date, namesFor(input.date, input.exercise));
      const payload = await request(
        "/api/logs",
        { method: "POST", body: JSON.stringify(input) },
        "保存に失敗しました",
      );
      const created = parseLog(payload);
      remember(created);
      return { ...created };
    },

    async touchExercise(name, atISO) {
      const exerciseName = assertName(name);
      const date = cache?.date ?? toISODate(now);
      await need(date, []);
      const current = requireCache(date);
      if (!current.logs.has(exerciseName)) current.logs.set(exerciseName, { previous: null, today: null });
      return upsertExercise(exerciseName, atISO);
    },
  };
}
