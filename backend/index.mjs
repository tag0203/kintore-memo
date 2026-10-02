/**
 * Lambda entry for the Notion wrapper (#10) and DayPlan (#6).
 * Item shapes come from dynamodb.mjs (docs/dynamodb.md).
 * worker/ is the reference implementation and is not invoked here.
 *
 * Public:  GET /api/health
 * Auth:    API Gateway JWT authorizer on /api/{proxy+}. This function does not
 *          check the token again. DayPlan uses requestContext.authorizer.jwt.claims.sub.
 *
 * GET  /api/exercises
 * GET  /api/exercises/recent
 * GET  /api/logs/previous?exercise=&before=YYYY-MM-DD
 * GET  /api/logs/today?exercise=&date=YYYY-MM-DD
 * GET  /api/bootstrap?date=YYYY-MM-DD&exercise=&exercises=
 * POST /api/logs
 * GET  /api/day-plan?date=YYYY-MM-DD
 * PUT  /api/day-plan     { date, memo, exercises, finished }
 *
 * HTTP API payload v2 puts the stage name on rawPath (e.g. /dev/api/health).
 * Prefer routeKey for health, which is stage-independent ("GET /api/health").
 */

import { getDayPlan, jwtSubject, putDayPlan } from "./dayPlan.mjs";
import { createDefaultDayPlanStore } from "./dayPlanStore.mjs";
import { ItemValidationError } from "./dynamodb.mjs";
import { createNotionClient } from "./notionClient.mjs";
import { createDefaultNotionCache } from "./notionCache.mjs";
import { createNotionService } from "./notionService.mjs";
import { createDefaultSecretLoader, notionConfigured } from "./secrets.mjs";
import {
  RequestValidationError,
  assertExerciseName,
  assertISODate,
  parseExerciseList,
  readCreateBody,
} from "./validate.mjs";

const json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  },
  body: JSON.stringify(body),
});

/** Strip named-stage prefix from HTTP API v2 rawPath when present. */
export function resolvePath(event) {
  const rawPath = event.rawPath ?? event.path ?? "/";
  const stage = event.requestContext?.stage;
  if (stage && stage !== "$default" && rawPath.startsWith(`/${stage}/`)) {
    return rawPath.slice(stage.length + 1) || "/";
  }
  return rawPath;
}

export function isHealthGet(event) {
  if (event.routeKey === "GET /api/health") return true;
  const method = event.requestContext?.http?.method ?? event.httpMethod ?? "GET";
  return method === "GET" && resolvePath(event) === "/api/health";
}

function searchParams(event) {
  if (typeof event.rawQueryString === "string") return new URLSearchParams(event.rawQueryString);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(event.queryStringParameters ?? {})) {
    if (typeof value === "string") params.append(key, value);
  }
  return params;
}

function readEventJson(event) {
  if (event.body == null || event.body === "") return {};
  const text = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  return JSON.parse(text);
}

function publicMessage(error) {
  const message = error instanceof Error ? error.message : "処理に失敗しました";
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/ntn_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/secret_[A-Za-z0-9]+/g, "[redacted]");
}

function statusFor(message) {
  if (message.includes("設定されていません") || message.includes("設定がありません")) return 500;
  return 502;
}

/**
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   now?: () => Date,
 *   dayPlanStore?: { get: Function, put: Function },
 *   cache?: { get: Function, put: Function, delete: Function, deleteWhere: Function },
 *   loadSecrets?: (env: Record<string, string | undefined>) => Promise<{ token: string, databaseId: string }>,
 *   createClient?: (env: { NOTION_TOKEN: string, NOTION_DATABASE_ID: string }) => object,
 * }} [deps]
 */
export function createHandler(deps = {}) {
  const envOf = () => deps.env ?? process.env;
  const loadSecrets = deps.loadSecrets ?? createDefaultSecretLoader();
  /** @type {Promise<{ get: Function, put: Function, delete: Function, deleteWhere: Function }> | null} */
  let cachePromise = null;
  /** @type {Map<string, ReturnType<typeof createNotionService>>} */
  const services = new Map();
  /** @type {Promise<{ get: Function, put: Function }> | null} */
  let storePromise = null;

  function cache() {
    if (deps.cache) return Promise.resolve(deps.cache);
    cachePromise ??= createDefaultNotionCache(envOf());
    return cachePromise;
  }

  function dayPlanStore() {
    if (deps.dayPlanStore) return Promise.resolve(deps.dayPlanStore);
    storePromise ??= createDefaultDayPlanStore(envOf());
    return storePromise;
  }

  async function service() {
    const secrets = await loadSecrets(envOf());
    const key = `${secrets.databaseId}\0${secrets.token}`;
    const existing = services.get(key);
    if (existing) return existing;
    const client = (deps.createClient ?? createNotionClient)({
      NOTION_TOKEN: secrets.token,
      NOTION_DATABASE_ID: secrets.databaseId,
    });
    const created = createNotionService({ client, cache: await cache() });
    services.set(key, created);
    return created;
  }

  /**
   * @param {Record<string, unknown>} event
   * @param {string} method
   */
  async function handleDayPlan(event, method) {
    if (method !== "GET" && method !== "PUT") {
      return json(405, { error: "method_not_allowed", message: "GET または PUT を使ってください" }, { allow: "GET, PUT" });
    }
    const tableReady = Boolean(deps.dayPlanStore) || Boolean(envOf().TABLE_NAME);
    if (!tableReady) {
      return json(503, { error: "table_unconfigured", message: "TABLE_NAME がありません" });
    }
    const userId = jwtSubject(event);
    if (!userId) {
      return json(401, { error: "unauthorized", message: "ログインが必要です" });
    }
    try {
      const store = await dayPlanStore();
      const now = deps.now ? deps.now() : new Date();
      const result =
        method === "GET"
          ? await getDayPlan({ userId, date: searchParams(event).get("date"), store, now })
          : await putDayPlan({ userId, body: readEventJson(event), store, now });
      return json(200, result);
    } catch (error) {
      if (error instanceof ItemValidationError) {
        if (error.code === "user_id") {
          return json(401, { error: "unauthorized", message: "ログインが必要です" });
        }
        return json(400, { error: error.code, message: error.message });
      }
      if (error instanceof SyntaxError) {
        return json(400, { error: "invalid_json", message: "JSON を確認してください" });
      }
      console.error("day plan failed", error instanceof Error ? error.name : "unknown");
      return json(502, { error: "storage", message: "DayPlan の読み書きに失敗しました" });
    }
  }

  return async function handler(event) {
    const method = event.requestContext?.http?.method ?? event.httpMethod ?? "GET";
    const path = resolvePath(event);

    if (method === "OPTIONS") {
      return { statusCode: 204, headers: {}, body: "" };
    }

    if (path === "/api/day-plan") {
      return handleDayPlan(event, method);
    }

    try {
      if (isHealthGet(event)) {
        const env = envOf();
        return json(200, {
          ok: true,
          service: "kintore-memo",
          stage: env.ENVIRONMENT || "local",
          notionConfigured: notionConfigured(env),
          tableName: env.TABLE_NAME ?? null,
        });
      }

      const params = searchParams(event);
      /** @type {null | (() => Promise<unknown>)} */
      let run = null;

      if (method === "GET" && path === "/api/exercises") {
        run = async () => (await service()).listExercises();
      } else if (method === "GET" && path === "/api/exercises/recent") {
        run = async () => (await service()).listRecentExercises();
      } else if (method === "GET" && path === "/api/logs/previous") {
        const exercise = assertExerciseName(params.get("exercise") ?? "");
        const before = assertISODate(params.get("before") ?? "", "before");
        run = async () => (await service()).getPreviousLog(exercise, before);
      } else if (method === "GET" && path === "/api/logs/today") {
        const exercise = assertExerciseName(params.get("exercise") ?? "");
        const date = assertISODate(params.get("date") ?? "", "date");
        run = async () => (await service()).getLogOnDate(exercise, date);
      } else if (method === "GET" && path === "/api/bootstrap") {
        const date = assertISODate(params.get("date") ?? "", "date");
        const exercises = parseExerciseList([...params.getAll("exercise"), ...params.getAll("exercises")]);
        run = async () => (await service()).bootstrap(date, exercises);
      } else if (method === "POST" && path === "/api/logs") {
        const input = readCreateBody(readEventJson(event));
        run = async () => (await service()).createLog(input);
      }

      if (!run) return json(404, { error: "見つかりません" });
      const body = await run();
      const statusCode = method === "POST" ? 201 : 200;
      return json(statusCode, body);
    } catch (error) {
      if (error instanceof RequestValidationError) return json(error.statusCode, { error: error.message });
      if (error instanceof SyntaxError) return json(400, { error: "JSON を確認してください" });
      const message = publicMessage(error);
      return json(statusFor(message), { error: message });
    }
  };
}

export const handler = createHandler();
