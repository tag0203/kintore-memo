import { apiUrl, authorizedFetch } from "../auth/authorizedFetch";
import { isDifficulty, tokyoCivilDate, type ExerciseLog, type ExerciseSummary, type NewExerciseLog } from "../domain";
import type { WorkoutLogClient } from "./client";
import { assertCatalogName } from "./exerciseName";
import { chronological } from "./logRows";
import { requestIdFromPayload } from "./requestId";

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
  previous: ExerciseLog[];
  today: ExerciseLog[];
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
  /**
   * 日付を引数に取らない読み取りで、キャッシュもまだ無いときのセッション日。
   * 端末のローカル日ではなく、東京の暦日にする。
   */
  now?: Date;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** サーバーが 5xx で返してよい固定文言。それ以外の本文は画面に出さない。 */
const SERVER_FAULTS = new Set([
  "Notion との通信に失敗しました",
  "サーバーでエラーが発生しました",
  "処理に失敗しました",
]);

function withRequestId(message: string, requestId: string): string {
  return requestId ? `${message}（${requestId}）` : message;
}

function messageFrom(payload: unknown, status: number, fallback: string): string {
  if (status >= 500) {
    let message = fallback;
    if (isRecord(payload) && typeof payload.error === "string" && SERVER_FAULTS.has(payload.error)) {
      message = payload.error;
    }
    return withRequestId(message, requestIdFromPayload(payload));
  }
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

function parseLogList(value: unknown): ExerciseLog[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("記録の取得に失敗しました");
  return chronological(value.map(parseLog));
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
    logs.set(name, { previous: parseLogList(pair.previous), today: parseLogList(pair.today) });
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

function copyLogs(logs: readonly ExerciseLog[] | undefined): ExerciseLog[] {
  return (logs ?? []).map((log) => ({ ...log }));
}

const emptyPair = (): LogPair => ({ previous: [], today: [] });

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

  let cacheEpoch = 0;

  async function pull(date: string, names: readonly string[], epoch: number): Promise<boolean> {
    const payload = await request(bootstrapPath(date, names), { method: "GET" }, "記録の取得に失敗しました");
    // 日付を切り替えたあとに、前の日付の応答でキャッシュを上書きしない。
    if (epoch !== cacheEpoch) return false;
    const parsed = parseBootstrap(payload);
    if (!cache || cache.date !== date) {
      cache = { date, exercises: [], logs: new Map(), catalogReady: false };
    }
    cache.exercises = mergeSummaries(parsed.exercises, parsed.recent);
    for (const [name, pair] of parsed.logs) cache.logs.set(name, pair);
    for (const name of names) {
      if (!cache.logs.has(name)) cache.logs.set(name, emptyPair());
    }
    return true;
  }

  async function load(date: string, names: readonly string[]): Promise<void> {
    if (cache && cache.date !== date) {
      cacheEpoch += 1;
      cache = null;
    }
    const epoch = cacheEpoch;
    const missing = names.filter((name) => !cache?.logs.has(name));
    const apply = async (chunk: readonly string[]) => {
      const kept = await pull(date, chunk, epoch);
      return kept;
    };
    if (!cache?.catalogReady) {
      if (missing.length === 0) {
        if (!(await apply([]))) return;
      } else {
        for (const chunk of chunks(missing, BOOTSTRAP_LIMIT)) {
          if (!(await apply(chunk))) return;
        }
      }
      if (epoch !== cacheEpoch) return;
      const extras = (cache?.exercises ?? [])
        .map((exercise) => exercise.name)
        .filter((name) => !cache?.logs.has(name));
      for (const chunk of chunks(extras, BOOTSTRAP_LIMIT)) {
        if (!(await apply(chunk))) return;
      }
      if (epoch !== cacheEpoch || !cache) return;
      cache.catalogReady = true;
      return;
    }
    for (const chunk of chunks(missing, BOOTSTRAP_LIMIT)) {
      if (!(await apply(chunk))) return;
    }
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
    const current = cache.logs.get(log.exercise) ?? emptyPair();
    const today = current.today.some((row) => row.id === log.id)
      ? current.today
      : chronological([...current.today, log]);
    cache.logs.set(log.exercise, { previous: current.previous, today });
    upsertExercise(log.exercise, log.createdAt);
  }

  function namesFor(date: string, exercise: string): string[] {
    if (cache?.catalogReady && cache.date === date) return [];
    return [exercise];
  }

  /** 明示されたセッション日 → いまのキャッシュの日 → 東京の今日。日付が違えば need がキャッシュを捨てて取り直す。 */
  function readDate(onDate?: string): string {
    if (onDate) return onDate;
    return cache?.date ?? tokyoCivilDate(now);
  }

  return {
    async listExercises(onDate?: string) {
      const date = readDate(onDate);
      await need(date, []);
      return requireCache(date).exercises.map((exercise) => ({ ...exercise }));
    },

    async listRecentExercises(onDate?: string) {
      const date = readDate(onDate);
      await need(date, []);
      return requireCache(date)
        .exercises.filter((exercise) => exercise.lastPickedAt)
        .slice()
        .sort((left, right) => (left.lastPickedAt! < right.lastPickedAt! ? 1 : -1))
        .map((exercise) => ({ ...exercise }));
    },

    async getPreviousLog(exercise, beforeDate) {
      await need(beforeDate, namesFor(beforeDate, exercise));
      return copyLogs(requireCache(beforeDate).logs.get(exercise)?.previous);
    },

    async getLogOnDate(exercise, date) {
      await need(date, namesFor(date, exercise));
      return copyLogs(requireCache(date).logs.get(exercise)?.today);
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

    async touchExercise(name, atISO, onDate?: string) {
      const exerciseName = assertCatalogName(name);
      const date = readDate(onDate);
      await need(date, []);
      const current = requireCache(date);
      if (!current.logs.has(exerciseName)) current.logs.set(exerciseName, emptyPair());
      return upsertExercise(exerciseName, atISO);
    },
  };
}
