import { describe, expect, it } from "vitest";
import { createHandler } from "./index.mjs";
import { createMemoryDayPlanStore } from "./dayPlanStore.mjs";
import { ENTITY_DAY_PLAN, dayPlanKey, dayPlanTtlEpochSeconds } from "./dynamodb.mjs";

const USER_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_ID = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-02T03:00:00.000Z");

function event({ method = "GET", path = "/api/day-plan", query = "", body, sub = USER_ID, stage = "dev" } = {}) {
  const rawPath = stage === "$default" ? path : `/${stage}${path}`;
  return {
    version: "2.0",
    routeKey: `${method} /api/{proxy+}`,
    rawPath,
    rawQueryString: query,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: {
      stage,
      http: { method, path: rawPath },
      authorizer: sub ? { jwt: { claims: { sub } } } : undefined,
    },
  };
}

function api(store = createMemoryDayPlanStore()) {
  return {
    store,
    handler: createHandler({
      env: {},
      now: () => NOW,
      dayPlanStore: store,
    }),
  };
}

function planBody(overrides = {}) {
  return {
    date: "2026-10-02",
    memo: "脚",
    exercises: ["スクワット", "レッグプレス"],
    finished: false,
    ...overrides,
  };
}

describe("DayPlan API", () => {
  it("returns an empty menu when the user has no item", async () => {
    const { handler, store } = api();
    let puts = 0;
    const wrapped = createHandler({
      env: {},
      now: () => NOW,
      dayPlanStore: {
        get: (key) => store.get(key),
        put: async () => {
          puts += 1;
        },
      },
    });
    const res = await wrapped(event({ query: "date=2026-10-02&userId=ignored" }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      date: "2026-10-02",
      memo: "",
      exercises: [],
      finished: false,
      updatedAt: null,
    });
    expect(puts).toBe(0);
  });

  it("puts the JWT subject and reads the same menu back", async () => {
    const { handler, store } = api();
    /** @type {Record<string, unknown>[]} */
    const written = [];
    const recording = createHandler({
      env: {},
      now: () => NOW,
      dayPlanStore: {
        get: (key) => store.get(key),
        put: async (item) => {
          written.push(item);
          await store.put(item);
        },
      },
    });
    const put = await recording(
      event({
        method: "PUT",
        body: planBody({
          memo: "脚\n",
          userId: OTHER_ID,
          weightKg: 80,
          reps: 11,
          sets: 3,
          difficulty: 4,
        }),
      }),
    );
    expect(put.statusCode).toBe(200);
    expect(JSON.parse(put.body)).toEqual({
      date: "2026-10-02",
      memo: "脚",
      exercises: ["スクワット", "レッグプレス"],
      finished: false,
      updatedAt: NOW.toISOString(),
    });
    expect(Object.keys(JSON.parse(put.body)).sort()).toEqual(
      ["date", "exercises", "finished", "memo", "updatedAt"].sort(),
    );
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      ...dayPlanKey(USER_ID, "2026-10-02"),
      entityType: ENTITY_DAY_PLAN,
      userId: USER_ID,
      ttl: dayPlanTtlEpochSeconds("2026-10-02"),
    });
    expect(written[0].weightKg).toBeUndefined();
    expect(written[0].userId).not.toBe(OTHER_ID);

    const got = await handler(event({ query: "date=2026-10-02" }));
    expect(got.statusCode).toBe(200);
    expect(JSON.parse(got.body).exercises).toEqual(["スクワット", "レッグプレス"]);
    expect(JSON.parse(got.body).memo).toBe("脚");
  });

  it("keeps exercise order across reload and accepts base64 JSON", async () => {
    const { handler, store } = api();
    const body = planBody({ exercises: ["レッグカール", "スクワット"], finished: true, memo: "" });
    const put = await handler({
      ...event({ method: "PUT", sub: USER_ID }),
      body: Buffer.from(JSON.stringify(body)).toString("base64"),
      isBase64Encoded: true,
    });
    expect(put.statusCode).toBe(200);
    const got = await handler(event({ query: "date=2026-10-01" }));
    expect(JSON.parse(got.body).exercises).toEqual([]);
    const today = await handler(event({ query: "date=2026-10-02", stage: "$default" }));
    expect(today.statusCode).toBe(200);
    expect(JSON.parse(today.body)).toMatchObject({
      exercises: ["レッグカール", "スクワット"],
      finished: true,
      memo: "",
    });
    const stored = await store.get(dayPlanKey(USER_ID, "2026-10-02"));
    expect(stored.exercises).toEqual(["レッグカール", "スクワット"]);
  });

  it("does not read another user's item", async () => {
    const { handler, store } = api();
    await handler(event({ method: "PUT", body: planBody({ memo: "背中" }) }));
    const other = await handler(event({ query: "date=2026-10-02", sub: OTHER_ID }));
    expect(JSON.parse(other.body)).toMatchObject({ memo: "", exercises: [] });
    const mine = await store.get(dayPlanKey(USER_ID, "2026-10-02"));
    expect(mine.memo).toBe("背中");
  });

  it("rejects dates outside the Tokyo window and invalid menus", async () => {
    const { handler, store } = api();
    const far = await handler(event({ method: "PUT", body: planBody({ date: "2026-09-01" }) }));
    expect(far.statusCode).toBe(400);
    expect(JSON.parse(far.body).error).toBe("date_window");
    const missing = await handler(event({ query: "" }));
    expect(missing.statusCode).toBe(400);
    expect(JSON.parse(missing.body).error).toBe("date");
    const dup = await handler(
      event({ method: "PUT", body: planBody({ exercises: ["スクワット", "スクワット"] }) }),
    );
    expect(JSON.parse(dup.body).error).toBe("duplicate_exercise");
    expect(await store.get(dayPlanKey(USER_ID, "2026-10-02"))).toBeNull();
  });

  it("requires a JWT sub and a configured table", async () => {
    const { handler } = api();
    const anon = await handler(event({ query: "date=2026-10-02", sub: null }));
    expect(anon.statusCode).toBe(401);
    expect(JSON.parse(anon.body).error).toBe("unauthorized");

    const badSub = await handler(event({ query: "date=2026-10-02", sub: "not-a-uuid" }));
    expect(badSub.statusCode).toBe(401);

    const unconfigured = createHandler({ env: {}, now: () => NOW });
    const res = await unconfigured(event({ query: "date=2026-10-02" }));
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toBe("table_unconfigured");
  });

  it("rejects the wrong method, bad JSON, and a corrupt stored item", async () => {
    const { handler, store } = api();
    const posted = await handler(event({ method: "POST", body: planBody() }));
    expect(posted.statusCode).toBe(405);

    const badJson = await handler(event({ method: "PUT", body: "{", }));
    expect(badJson.statusCode).toBe(400);
    expect(JSON.parse(badJson.body).error).toBe("invalid_json");

    await store.put({
      ...dayPlanKey(USER_ID, "2026-10-02"),
      entityType: ENTITY_DAY_PLAN,
      userId: USER_ID,
      date: "2026-10-02",
      memo: "脚",
      exercises: [],
      finished: false,
      updatedAt: NOW.toISOString(),
      ttl: 1,
    });
    const corrupt = await handler(event({ query: "date=2026-10-02" }));
    expect(corrupt.statusCode).toBe(502);
    expect(JSON.parse(corrupt.body).error).toBe("storage");
  });

  it("strips the stage prefix on the day-plan path", async () => {
    const { handler } = api();
    const res = await handler(event({ query: "date=2026-10-03", stage: "prod" }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).date).toBe("2026-10-03");
  });
});
