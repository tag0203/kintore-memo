/**
 * Notion API client used by the Lambda. Port of worker/notionClient.ts.
 * The browser never imports this. Tokens come from the caller (SSM or a test double).
 */
import {
  NOTION_VERSION,
  RECENT_PAGE_SIZE,
  assertWorkoutSchema,
  buildCreatePageBody,
  buildOnDateQuery,
  buildPreviousQuery,
  buildRecentQuery,
  PAGE_TITLE,
  exerciseNamesFromSchema,
  pageToLog,
} from "./notionMap.mjs";

/**
 * @param {{ NOTION_TOKEN?: string, NOTION_DATABASE_ID?: string }} env
 * @param {typeof fetch} [fetchImpl]
 */
export function createNotionClient(env, fetchImpl = fetch) {
  /** @type {null | { databaseId: string, dataSourceId: string, titleProperty: string, properties: Record<string, unknown> }} */
  let schemaCache = null;
  /** @type {Promise<NonNullable<typeof schemaCache>> | null} */
  let resolving = null;

  async function notion(path, init) {
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
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && "message" in payload
          ? String(payload.message)
          : `HTTP ${response.status}`;
      throw new Error(`Notion API: ${message}`);
    }
    return payload;
  }

  async function resolve() {
    if (!env.NOTION_TOKEN) throw new Error("NOTION_TOKEN が設定されていません");
    if (!env.NOTION_DATABASE_ID) throw new Error("NOTION_DATABASE_ID が設定されていません");
    if (schemaCache && schemaCache.databaseId === env.NOTION_DATABASE_ID) return schemaCache;
    if (!resolving) {
      resolving = (async () => {
        const database = await notion(`/databases/${env.NOTION_DATABASE_ID}`);
        const dataSourceId = database.data_sources?.[0]?.id;
        if (!dataSourceId) throw new Error("データベースにデータソースがありません");
        const source = await notion(`/data_sources/${dataSourceId}`);
        const properties = source.properties ?? {};
        const { titleProperty } = assertWorkoutSchema(properties);
        schemaCache = { databaseId: env.NOTION_DATABASE_ID, dataSourceId, titleProperty, properties };
        return schemaCache;
      })().finally(() => {
        resolving = null;
      });
    }
    return resolving;
  }

  async function query(body) {
    const source = await resolve();
    const result = await notion(`/data_sources/${source.dataSourceId}/query`, {
      method: "POST",
      body,
    });
    const pages = Array.isArray(result.results) ? result.results : [];
    return {
      source,
      pages,
      hasMore: Boolean(result.has_more),
      nextCursor: typeof result.next_cursor === "string" ? result.next_cursor : "",
    };
  }

  function chronological(logs) {
    return [...logs].sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
      if (left.id !== right.id) return left.id < right.id ? -1 : 1;
      return 0;
    });
  }

  function logsFrom(source, pages) {
    const logs = [];
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
      const { source, pages } = await query(buildRecentQuery());
      const seen = new Set();
      const recent = [];
      for (const log of logsFrom(source, pages)) {
        if (seen.has(log.exercise)) continue;
        seen.add(log.exercise);
        recent.push({ name: log.exercise, lastPickedAt: log.createdAt });
      }
      return recent;
    },

    /**
     * One query for the newest logs. `complete` is false when older pages exist,
     * so callers must not treat a missing row as "no history".
     */
    async loadRecentWindow() {
      const { source, pages, hasMore } = await query(buildRecentQuery());
      return {
        logs: logsFrom(source, pages),
        complete: !hasMore && pages.length < RECENT_PAGE_SIZE,
      };
    },

    async getPreviousLog(exercise, beforeDate) {
      const rows = [];
      let day = "";
      let cursor = "";
      for (let page = 0; page < 20; page += 1) {
        const body = buildPreviousQuery(exercise, beforeDate);
        if (cursor) body.start_cursor = cursor;
        const result = await query(body);
        const logs = logsFrom(result.source, result.pages);
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
      const rows = [];
      let cursor = "";
      for (let page = 0; page < 20; page += 1) {
        const body = buildOnDateQuery(exercise, date);
        if (cursor) body.start_cursor = cursor;
        const result = await query(body);
        rows.push(...logsFrom(result.source, result.pages));
        if (!result.hasMore || !result.nextCursor || result.nextCursor === cursor) break;
        cursor = result.nextCursor;
      }
      return chronological(rows);
    },

    async createLog(input) {
      const source = await resolve();
      const exercise = input.exercise.trim();
      const page = await notion("/pages", {
        method: "POST",
        body: buildCreatePageBody(source.dataSourceId, source.titleProperty, { ...input, exercise }),
      });
      schemaCache = null;
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
  };
}
