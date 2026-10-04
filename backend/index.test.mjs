import { describe, expect, it } from "vitest";
import { createMemoryNotionCache } from "./notionCache.mjs";
import { createHandler, handler, isHealthGet, resolvePath } from "./index.mjs";

function httpApiEvent({
  method = "GET",
  rawPath,
  routeKey,
  stage = "dev",
  rawQueryString,
  body,
  isBase64Encoded,
} = {}) {
  return {
    version: "2.0",
    routeKey: routeKey ?? `${method} ${rawPath?.replace(new RegExp(`^/${stage}`), "") || "/"}`,
    rawPath,
    rawQueryString,
    body,
    isBase64Encoded,
    requestContext: {
      stage,
      http: { method, path: rawPath },
    },
  };
}

const squat = {
  id: "page-1",
  exercise: "スクワット",
  weightKg: 80,
  reps: 11,
  sets: 3,
  difficulty: 3,
  date: "2026-09-25",
  title: "－",
  createdAt: "2026-09-25T12:00:00.000Z",
};

function app(client, env = {}) {
  let created = 0;
  const handlerFn = createHandler({
    env: { NOTION_TOKEN: "secret_token", NOTION_DATABASE_ID: "db-1", ...env },
    cache: createMemoryNotionCache({ now: () => new Date("2026-10-02T00:00:00.000Z") }),
    loadSecrets: async () => ({ token: "secret_token", databaseId: "db-1" }),
    createClient: () => client ?? {
      async listExercises() {
        return [{ name: "スクワット", lastPickedAt: null }];
      },
      async loadRecentWindow() {
        return { logs: [squat], complete: true };
      },
      async getPreviousLog() {
        return [];
      },
      async getLogOnDate() {
        return [];
      },
      async createLog(input) {
        created += 1;
        return { ...squat, ...input, id: "new", title: "－", createdAt: "2026-10-02T01:00:00.000Z" };
      },
    },
  });
  return { handler: handlerFn, created: () => created };
}

describe("resolvePath", () => {
  it("strips a named stage prefix from rawPath", () => {
    expect(resolvePath({ rawPath: "/dev/api/health", requestContext: { stage: "dev" } })).toBe("/api/health");
  });

  it("leaves $default paths unchanged", () => {
    expect(resolvePath({ rawPath: "/api/health", requestContext: { stage: "$default" } })).toBe("/api/health");
  });

  it("leaves paths that do not start with the stage unchanged", () => {
    expect(resolvePath({ rawPath: "/api/health", requestContext: { stage: "dev" } })).toBe("/api/health");
  });
});

describe("isHealthGet / handler", () => {
  it("returns 200 for named-stage rawPath via routeKey", async () => {
    const event = httpApiEvent({
      rawPath: "/dev/api/health",
      routeKey: "GET /api/health",
      stage: "dev",
    });
    expect(isHealthGet(event)).toBe(true);
    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });

  it("returns 200 for staging and prod stage prefixes", async () => {
    for (const stage of ["staging", "prod"]) {
      const event = httpApiEvent({
        rawPath: `/${stage}/api/health`,
        routeKey: "GET /api/health",
        stage,
      });
      expect((await handler(event)).statusCode).toBe(200);
    }
  });

  it("returns 200 when routeKey is missing but stage-stripped path matches", async () => {
    const event = {
      rawPath: "/dev/api/health",
      requestContext: { stage: "dev", http: { method: "GET", path: "/dev/api/health" } },
    };
    expect((await handler(event)).statusCode).toBe(200);
  });

  it("returns 200 for $default /api/health", async () => {
    const event = httpApiEvent({
      rawPath: "/api/health",
      routeKey: "GET /api/health",
      stage: "$default",
    });
    expect((await handler(event)).statusCode).toBe(200);
  });

  it("reports configuration without echoing the token", async () => {
    const local = createHandler({
      env: {
        NOTION_TOKEN: "secret_token",
        NOTION_DATABASE_ID: "db-1",
        ENVIRONMENT: "dev",
        TABLE_NAME: "kintore-memo-dev",
      },
    });
    const res = await local(httpApiEvent({ rawPath: "/api/health", routeKey: "GET /api/health", stage: "$default" }));
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      ok: true,
      service: "kintore-memo",
      stage: "dev",
      notionConfigured: true,
      tableName: "kintore-memo-dev",
    });
    expect(res.body).not.toContain("secret_token");
  });

  it("serves protected routes without a second auth check in Lambda", async () => {
    const { handler: local } = app();
    const res = await local(httpApiEvent({ rawPath: "/dev/api/exercises", stage: "dev" }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([{ name: "スクワット", lastPickedAt: null }]);
    expect(res.requestContext).toBeUndefined();
  });

  it("bootstraps previous and today for the session date", async () => {
    const { handler: local } = app();
    const res = await local(
      httpApiEvent({
        rawPath: "/dev/api/bootstrap",
        stage: "dev",
        rawQueryString: "date=2026-10-02&exercise=%E3%82%B9%E3%82%AF%E3%83%AF%E3%83%83%E3%83%88",
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).logs["スクワット"]).toMatchObject({
      previous: [{ weightKg: 80, date: "2026-09-25" }],
      today: [],
    });
  });

  it("rejects an invalid log before calling Notion", async () => {
    let created = 0;
    const { handler: local } = app({
      async listExercises() {
        return [];
      },
      async loadRecentWindow() {
        return { logs: [], complete: true };
      },
      async getPreviousLog() {
        return [];
      },
      async getLogOnDate() {
        return [];
      },
      async createLog() {
        created += 1;
        throw new Error("Notion create should not run");
      },
    });
    const res = await local(
      httpApiEvent({
        method: "POST",
        rawPath: "/dev/api/logs",
        stage: "dev",
        body: JSON.stringify({ exercise: "スクワット", weightKg: -20, reps: 11, sets: 3, difficulty: 3, date: "2026-10-02" }),
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(created).toBe(0);
  });

  it("creates a log from a base64 body", async () => {
    let created = 0;
    const { handler: local } = app({
      async createLog(input) {
        created += 1;
        return { ...squat, ...input, id: "new", title: "－", createdAt: "2026-10-02T01:00:00.000Z" };
      },
    });
    const payload = {
      exercise: "スクワット",
      weightKg: 82.5,
      reps: 11,
      sets: 3,
      difficulty: 3,
      date: "2026-10-02",
    };
    const res = await local(
      httpApiEvent({
        method: "POST",
        rawPath: "/api/logs",
        stage: "$default",
        isBase64Encoded: true,
        body: Buffer.from(JSON.stringify(payload)).toString("base64"),
      }),
    );
    expect(res.statusCode).toBe(201);
    expect(created).toBe(1);
    expect(JSON.parse(res.body)).toMatchObject({ exercise: "スクワット", weightKg: 82.5 });
    expect(res.body).not.toContain("secret_token");
  });

  it("returns 500 when Notion is not configured and does not invent a route", async () => {
    const local = createHandler({ env: {} });
    const missing = await local(httpApiEvent({ rawPath: "/dev/api/exercises", stage: "dev" }));
    expect(missing.statusCode).toBe(500);
    expect(JSON.parse(missing.body).error).toContain("設定がありません");

    const unknown = await local(httpApiEvent({ rawPath: "/dev/api/unknown", stage: "dev" }));
    expect(unknown.statusCode).toBe(404);
  });

  it("redacts token-shaped text in Notion errors", async () => {
    const { handler: local } = app({
      async listExercises() {
        throw new Error("Notion API: unauthorized ntn_secretvalue");
      },
    });
    const res = await local(httpApiEvent({ rawPath: "/api/exercises", stage: "$default" }));
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain("ntn_secretvalue");
    expect(res.body).toContain("[redacted]");
  });
});
