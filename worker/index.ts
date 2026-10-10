/**
 * Cloudflare Worker reference for the Notion HTTP shape.
 * Not the production path. Deployed traffic goes to API Gateway and the Go Lambda in api/.
 */
import { isDifficulty, isISODate, isValidCount, isValidWeightKg, type NewExerciseLog } from "../src/domain";
import type { WorkoutLogClient } from "../src/data/client";
import type { NotionEnv } from "./env";
import { createNotionClient } from "./notionClient";

export interface HandlerDeps {
  createClient?: (env: NotionEnv) => WorkoutLogClient;
}

function responseHeaders(env: NotionEnv): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
  };
  if (env.ALLOWED_ORIGIN) {
    headers["access-control-allow-origin"] = env.ALLOWED_ORIGIN;
    headers["access-control-allow-methods"] = "GET, POST, OPTIONS";
    headers["access-control-allow-headers"] = "content-type";
  }
  return headers;
}

function json(env: NotionEnv, body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: responseHeaders(env) });
}

function badRequest(env: NotionEnv, error: string): Response {
  return json(env, { error }, 400);
}

function readCreateBody(value: unknown): NewExerciseLog | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (typeof body.exercise !== "string") return null;
  if (typeof body.weightKg !== "number" || !isValidWeightKg(body.weightKg)) return null;
  if (typeof body.reps !== "number" || !isValidCount(body.reps)) return null;
  if (typeof body.sets !== "number" || !isValidCount(body.sets)) return null;
  if (typeof body.difficulty !== "number" || !isDifficulty(body.difficulty)) return null;
  if (typeof body.date !== "string" || !isISODate(body.date)) return null;
  if (body.title !== undefined && typeof body.title !== "string") return null;
  return {
    exercise: body.exercise,
    weightKg: body.weightKg,
    reps: body.reps,
    sets: body.sets,
    difficulty: body.difficulty,
    date: body.date,
    title: typeof body.title === "string" ? body.title : undefined,
  };
}

/**
 * 画面が後で叩く API。いまの React アプリはこの経路を使わない。
 *
 * GET  /api/health
 * GET  /api/exercises
 * GET  /api/exercises/recent
 * GET  /api/logs/previous?exercise=&before=YYYY-MM-DD
 * GET  /api/logs/today?exercise=&date=YYYY-MM-DD
 * POST /api/logs
 */
export async function handleRequest(
  request: Request,
  env: NotionEnv,
  deps: HandlerDeps = {},
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: responseHeaders(env) });
  }

  const url = new URL(request.url);
  const createClient = deps.createClient ?? createNotionClient;

  try {
    if (url.pathname === "/api/health" && request.method === "GET") {
      return json(env, { ok: true });
    }

    if (url.pathname === "/api/exercises" && request.method === "GET") {
      return json(env, await createClient(env).listExercises());
    }

    if (url.pathname === "/api/exercises/recent" && request.method === "GET") {
      return json(env, await createClient(env).listRecentExercises());
    }

    if (url.pathname === "/api/logs/previous" && request.method === "GET") {
      const exercise = url.searchParams.get("exercise")?.trim() ?? "";
      const before = url.searchParams.get("before") ?? "";
      if (!exercise || !isISODate(before)) return badRequest(env, "exercise と before が必要です");
      return json(env, await createClient(env).getPreviousLog(exercise, before));
    }

    if (url.pathname === "/api/logs/today" && request.method === "GET") {
      const exercise = url.searchParams.get("exercise")?.trim() ?? "";
      const date = url.searchParams.get("date") ?? "";
      if (!exercise || !isISODate(date)) return badRequest(env, "exercise と date が必要です");
      return json(env, await createClient(env).getLogOnDate(exercise, date));
    }

    if (url.pathname === "/api/logs" && request.method === "POST") {
      const input = readCreateBody(JSON.parse(await request.text()) as unknown);
      if (!input) return badRequest(env, "記録の形式を確認してください");
      const log = await createClient(env).createLog(input);
      return json(env, log, 201);
    }

    return json(env, { error: "見つかりません" }, 404);
  } catch (error) {
    if (error instanceof SyntaxError) return badRequest(env, "JSON を確認してください");
    const raw = error instanceof Error ? error.message : "";
    if (raw.includes("設定されていません") || raw.includes("設定がありません")) {
      return json(env, { error: "サーバーでエラーが発生しました" }, 500);
    }
    return json(env, { error: "Notion との通信に失敗しました" }, 502);
  }
}

export default {
  fetch(request: Request, env: NotionEnv): Promise<Response> {
    return handleRequest(request, env);
  },
};
