import type { ExerciseLog, ExerciseSummary } from "../src/domain";
import { PAGE_TITLE } from "../src/domain";
import type { WorkoutLogClient } from "../src/data/client";
import { chronological } from "../src/data/logRows";
import type { NotionEnv } from "./env";
import {
  NOTION_VERSION,
  assertWorkoutSchema,
  buildCreatePageBody,
  buildOnDateQuery,
  buildPreviousQuery,
  buildRecentQuery,
  exerciseNamesFromSchema,
  pageToLog,
  type NotionPageLike,
  type NotionPropertySchema,
} from "./notionMap";

interface ResolvedSource {
  databaseId: string;
  dataSourceId: string;
  titleProperty: string;
  properties: Record<string, NotionPropertySchema>;
}

/**
 * Notion 公式 API を叩くクライアント。Worker からだけ import する。
 * トークンは引数の env から読み、ブラウザ用のビルドにはこのファイルを含めない。
 */
export function createNotionClient(env: NotionEnv, fetchImpl: typeof fetch = fetch): WorkoutLogClient {
  let cache: ResolvedSource | null = null;

  async function notion(path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
    if (!env.NOTION_TOKEN) throw new Error("NOTION_TOKEN が設定されていません");
    const response = await fetchImpl(`https://api.notion.com/v1${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    const payload: unknown = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && "message" in payload
          ? String((payload as { message: unknown }).message)
          : `HTTP ${response.status}`;
      throw new Error(`Notion API: ${message}`);
    }
    return payload;
  }

  async function resolve(): Promise<ResolvedSource> {
    if (!env.NOTION_TOKEN) throw new Error("NOTION_TOKEN が設定されていません");
    if (!env.NOTION_DATABASE_ID) throw new Error("NOTION_DATABASE_ID が設定されていません");
    if (cache && cache.databaseId === env.NOTION_DATABASE_ID) return cache;

    const database = (await notion(`/databases/${env.NOTION_DATABASE_ID}`)) as {
      data_sources?: { id?: string }[];
    };
    const dataSourceId = database.data_sources?.[0]?.id;
    if (!dataSourceId) throw new Error("データベースにデータソースがありません");

    const source = (await notion(`/data_sources/${dataSourceId}`)) as {
      properties?: Record<string, NotionPropertySchema>;
    };
    const properties = source.properties ?? {};
    const { titleProperty } = assertWorkoutSchema(properties);
    cache = { databaseId: env.NOTION_DATABASE_ID, dataSourceId, titleProperty, properties };
    return cache;
  }

  async function query(body: unknown): Promise<{ pages: NotionPageLike[]; hasMore: boolean; nextCursor: string }> {
    const source = await resolve();
    const result = (await notion(`/data_sources/${source.dataSourceId}/query`, {
      method: "POST",
      body,
    })) as { results?: NotionPageLike[]; has_more?: boolean; next_cursor?: string };
    return {
      pages: result.results ?? [],
      hasMore: Boolean(result.has_more),
      nextCursor: result.next_cursor ?? "",
    };
  }

  function logsOf(source: ResolvedSource, pages: NotionPageLike[]): ExerciseLog[] {
    const logs: ExerciseLog[] = [];
    for (const page of pages) {
      const log = pageToLog(page, source.titleProperty);
      if (log) logs.push(log);
    }
    return logs;
  }

  return {
    async listExercises() {
      const source = await resolve();
      return exerciseNamesFromSchema(source.properties).map((name) => ({ name, lastPickedAt: null }));
    },

    async listRecentExercises() {
      const source = await resolve();
      const { pages } = await query(buildRecentQuery());
      const seen = new Set<string>();
      const recent: ExerciseSummary[] = [];
      for (const page of pages) {
        const log = pageToLog(page, source.titleProperty);
        if (!log || seen.has(log.exercise)) continue;
        seen.add(log.exercise);
        recent.push({ name: log.exercise, lastPickedAt: log.createdAt });
      }
      return recent;
    },

    async getPreviousLog(exercise, beforeDate) {
      const source = await resolve();
      const rows: ExerciseLog[] = [];
      let day = "";
      let cursor = "";
      for (let page = 0; page < 20; page += 1) {
        const body = {
          ...buildPreviousQuery(exercise, beforeDate),
          ...(cursor ? { start_cursor: cursor } : {}),
        };
        const result = await query(body);
        const logs = logsOf(source, result.pages);
        if (logs.length === 0) break;
        if (!day) day = logs.reduce((max, log) => (log.date > max ? log.date : max), logs[0].date);
        let older = false;
        for (const log of logs) {
          if (log.date === day) rows.push(log);
          else if (log.date < day) older = true;
        }
        if (older || !result.hasMore || !result.nextCursor || result.nextCursor === cursor) break;
        cursor = result.nextCursor;
      }
      return chronological(rows);
    },

    async getLogOnDate(exercise, date) {
      const source = await resolve();
      const rows: ExerciseLog[] = [];
      let cursor = "";
      for (let page = 0; page < 20; page += 1) {
        const body = {
          ...buildOnDateQuery(exercise, date),
          ...(cursor ? { start_cursor: cursor } : {}),
        };
        const result = await query(body);
        rows.push(...logsOf(source, result.pages));
        if (!result.hasMore || !result.nextCursor || result.nextCursor === cursor) break;
        cursor = result.nextCursor;
      }
      return chronological(rows);
    },

    async createLog(input) {
      const source = await resolve();
      const exercise = input.exercise.trim();
      const page = (await notion("/pages", {
        method: "POST",
        body: buildCreatePageBody(source.dataSourceId, source.titleProperty, { ...input, exercise }),
      })) as NotionPageLike;
      cache = null;
      const log = pageToLog(page, source.titleProperty);
      if (log) return log;
      return {
        id: page.id,
        exercise,
        weightKg: input.weightKg,
        reps: input.reps,
        sets: input.sets,
        difficulty: input.difficulty,
        date: input.date,
        title: input.title?.trim() || PAGE_TITLE,
        createdAt: page.created_time ?? new Date().toISOString(),
      };
    },

    async touchExercise(name, atISO) {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("種目名を入力してください");
      if (trimmed.length > 40) throw new Error("種目名は40文字以内にしてください");
      // 種目セレクトの選択肢は、最初の記録を保存したときに Notion 側で増える。
      return { name: trimmed, lastPickedAt: atISO };
    },
  };
}
