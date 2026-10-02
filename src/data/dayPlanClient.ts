import { apiUrl, authorizedFetch } from "../auth/authorizedFetch";

/** 画面のセッションのうち、DayPlan に載せる分。重量・回数・セット・きつさは含めない。 */
export interface DayPlanInput {
  date: string;
  memo: string;
  exercises: string[];
  finished: boolean;
}

export interface DayPlanSnapshot extends DayPlanInput {
  updatedAt: string | null;
}

export interface DayPlanClient {
  load(date: string): Promise<DayPlanSnapshot>;
  save(input: DayPlanInput): Promise<DayPlanSnapshot>;
}

export class DayPlanRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "DayPlanRequestError";
    this.status = status;
    this.code = code;
  }
}

const ERROR_TEXT: Record<string, string> = {
  date: "日付の形式を確認してください",
  date_window: "その日付のメニューは保存できません",
  memo_invalid: "部位メモを確認してください",
  memo_too_long: "部位メモが長すぎます",
  exercise_invalid: "種目名を確認してください",
  exercise_too_long: "種目名が長すぎます",
  exercises_invalid: "種目の一覧を確認してください",
  exercises_too_many: "種目が多すぎます",
  duplicate_exercise: "同じ種目が重複しています",
  finished_invalid: "終了状態を確認してください",
  body_invalid: "保存内容を確認してください",
  invalid_json: "保存内容を確認してください",
  unauthorized: "ログインが必要です",
  table_unconfigured: "保存先が設定されていません",
  storage: "メニューの保存先に接続できませんでした",
  method_not_allowed: "メニューを保存できませんでした",
};

function messageFor(code: string, status: number, fallback: string): string {
  if (ERROR_TEXT[code]) return ERROR_TEXT[code];
  if (status === 401) return "ログインが必要です";
  if (status >= 500) return "メニューの保存先に接続できませんでした";
  return fallback;
}

async function readError(response: Response, fallback: string): Promise<DayPlanRequestError> {
  let code = "request_failed";
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === "string" && payload.error) code = payload.error;
  } catch {
    // 本文が JSON でないときも、ステータスから文言を選ぶ。
  }
  return new DayPlanRequestError(messageFor(code, response.status, fallback), response.status, code);
}

function readSnapshot(value: unknown): DayPlanSnapshot {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new DayPlanRequestError("メニューの応答を読めませんでした", 502, "invalid_response");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.date !== "string" || typeof record.memo !== "string" || typeof record.finished !== "boolean") {
    throw new DayPlanRequestError("メニューの応答を読めませんでした", 502, "invalid_response");
  }
  if (!Array.isArray(record.exercises) || record.exercises.some((name) => typeof name !== "string")) {
    throw new DayPlanRequestError("メニューの応答を読めませんでした", 502, "invalid_response");
  }
  if (record.updatedAt != null && typeof record.updatedAt !== "string") {
    throw new DayPlanRequestError("メニューの応答を読めませんでした", 502, "invalid_response");
  }
  return {
    date: record.date,
    memo: record.memo,
    exercises: [...record.exercises],
    finished: record.finished,
    updatedAt: record.updatedAt ?? null,
  };
}

export function createHttpDayPlanClient(options: {
  apiBaseUrl: string;
  getIdToken: () => Promise<string>;
}): DayPlanClient {
  const { apiBaseUrl, getIdToken } = options;

  return {
    async load(date: string) {
      const response = await authorizedFetch(
        apiUrl(apiBaseUrl, `/api/day-plan?date=${encodeURIComponent(date)}`),
        { method: "GET" },
        getIdToken,
      );
      if (!response.ok) throw await readError(response, "メニューを読み込めませんでした");
      return readSnapshot(await response.json());
    },
    async save(input: DayPlanInput) {
      const response = await authorizedFetch(
        apiUrl(apiBaseUrl, "/api/day-plan"),
        {
          method: "PUT",
          body: JSON.stringify({
            date: input.date,
            memo: input.memo,
            exercises: input.exercises,
            finished: input.finished,
          }),
          keepalive: true,
        },
        getIdToken,
      );
      if (!response.ok) throw await readError(response, "メニューを保存できませんでした");
      return readSnapshot(await response.json());
    },
  };
}
