import { describe, expect, it } from "vitest";
import {
  DAY_PLAN_TTL_DAYS,
  ENTITY_DAY_PLAN,
  ENTITY_NOTION_CACHE,
  ItemValidationError,
  LIMITS,
  NOTION_CACHE_PK,
  NOTION_CACHE_TTL_SECONDS,
  PARTITION_KEY,
  SORT_KEY,
  TTL_ATTRIBUTE,
  addCalendarDays,
  buildDayPlanItem,
  buildNotionCacheItem,
  dayPlanKey,
  dayPlanTtlEpochSeconds,
  isWritableSessionDate,
  notionCacheTtlEpochSeconds,
  readDayPlanItem,
  readNotionCacheItem,
  tokyoCivilDate,
} from "./dynamodb.mjs";

const USER_ID = "11111111-2222-4333-8444-555555555555";
const NOW = new Date("2026-10-02T03:00:00.000Z");

function errorCode(fn) {
  try {
    fn();
  } catch (error) {
    if (error instanceof ItemValidationError) return error.code;
    throw error;
  }
  throw new Error("expected ItemValidationError");
}

function plan(overrides = {}) {
  return buildDayPlanItem({
    userId: USER_ID,
    date: "2026-10-02",
    memo: "脚",
    exercises: ["スクワット", "レッグプレス", "レッグカール"],
    finished: false,
    now: NOW,
    ...overrides,
  });
}

describe("DayPlan keys and TTL", () => {
  it("uses USER#sub and DAY#date on the single table", () => {
    expect(dayPlanKey(USER_ID, "2026-10-02")).toEqual({
      pk: "USER#11111111-2222-4333-8444-555555555555",
      sk: "DAY#2026-10-02",
    });
  });

  it("expires at 00:00 Asia/Tokyo two calendar days after the session date", () => {
    expect(DAY_PLAN_TTL_DAYS).toBe(2);
    expect(dayPlanTtlEpochSeconds("2026-10-02")).toBe(
      Math.floor(Date.parse("2026-10-03T15:00:00.000Z") / 1000),
    );
    expect(new Date(dayPlanTtlEpochSeconds("2026-10-02") * 1000).toISOString()).toBe(
      "2026-10-03T15:00:00.000Z",
    );
    expect(new Date(dayPlanTtlEpochSeconds("2024-02-28") * 1000).toISOString()).toBe(
      "2024-02-29T15:00:00.000Z",
    );
  });

  it("stores menu, memo, and finished as one item", () => {
    const item = plan({ memo: " 脚 \n", finished: true });
    expect(item).toMatchObject({
      pk: `USER#${USER_ID}`,
      sk: "DAY#2026-10-02",
      entityType: ENTITY_DAY_PLAN,
      userId: USER_ID,
      date: "2026-10-02",
      memo: " 脚 ",
      exercises: ["スクワット", "レッグプレス", "レッグカール"],
      finished: true,
      updatedAt: "2026-10-02T03:00:00.000Z",
      ttl: dayPlanTtlEpochSeconds("2026-10-02"),
    });
    expect(item.ttl).toBe(item[TTL_ATTRIBUTE]);
    expect(Object.keys(item).sort()).toEqual(
      [
        "date",
        "entityType",
        "exercises",
        "finished",
        "memo",
        PARTITION_KEY,
        SORT_KEY,
        TTL_ATTRIBUTE,
        "updatedAt",
        "userId",
      ].sort(),
    );
    expect(readDayPlanItem(item)).toEqual(item);
  });

  it("keeps exercise order and trims names", () => {
    const item = plan({ exercises: [" レッグカール ", "スクワット"] });
    expect(item.exercises).toEqual(["レッグカール", "スクワット"]);
  });

  it("rejects a date outside the Tokyo today window", () => {
    expect(tokyoCivilDate(NOW)).toBe("2026-10-02");
    expect(isWritableSessionDate("2026-10-01", NOW)).toBe(true);
    expect(isWritableSessionDate("2026-10-03", NOW)).toBe(true);
    expect(isWritableSessionDate("2026-09-30", NOW)).toBe(false);
    expect(() => plan({ date: "2026-10-04" })).toThrow(ItemValidationError);
    try {
      plan({ date: "2099-01-01" });
    } catch (error) {
      expect(error).toBeInstanceOf(ItemValidationError);
      expect(error.code).toBe("date_window");
    }
  });

  it("rejects invalid identities, memos, and exercise lists", () => {
    expect(errorCode(() => plan({ userId: "USER#other" }))).toBe("user_id");
    expect(errorCode(() => plan({ date: "2026-02-31" }))).toBe("date");
    expect(errorCode(() => plan({ memo: `${"あ".repeat(LIMITS.memoLength + 1)}` }))).toBe("memo_too_long");
    expect(errorCode(() => plan({ memo: "脚\u0000" }))).toBe("memo_invalid");
    expect(errorCode(() => plan({ exercises: ["スクワット", "スクワット"] }))).toBe("duplicate_exercise");
    expect(errorCode(() => plan({ exercises: ["  "] }))).toBe("exercise_invalid");
    expect(errorCode(() => plan({ exercises: ["スクワット#脚"] }))).toBe("exercise_invalid");
    expect(
      errorCode(() => plan({ exercises: Array.from({ length: LIMITS.exerciseCount + 1 }, (_, i) => `種目${i}`) })),
    ).toBe("exercises_too_many");
    expect(errorCode(() => plan({ finished: "true" }))).toBe("finished_invalid");
  });

  it("does not accept a mismatched key when reading", () => {
    const item = plan();
    expect(errorCode(() => readDayPlanItem({ ...item, pk: "USER#00000000-0000-4000-8000-000000000000" }))).toBe(
      "key_mismatch",
    );
    expect(errorCode(() => readDayPlanItem({ ...item, entityType: ENTITY_NOTION_CACHE }))).toBe("entity_type");
  });
});

describe("NotionCache", () => {
  it("overwrites one short-lived item under CACHE#notion", () => {
    const now = new Date("2026-10-02T03:00:00.000Z");
    const item = buildNotionCacheItem({
      segments: ["logs", "previous", "スクワット", "2026-10-02"],
      body: '{"exercise":"スクワット"}',
      now,
    });
    expect(item).toEqual({
      pk: NOTION_CACHE_PK,
      sk: "logs#previous#スクワット#2026-10-02",
      entityType: ENTITY_NOTION_CACHE,
      cacheKey: "logs#previous#スクワット#2026-10-02",
      body: '{"exercise":"スクワット"}',
      cachedAt: "2026-10-02T03:00:00.000Z",
      ttl: notionCacheTtlEpochSeconds(now),
    });
    expect(item.ttl - Math.floor(now.getTime() / 1000)).toBe(NOTION_CACHE_TTL_SECONDS);
    expect(readNotionCacheItem(item)).toEqual(item);
    expect(item.pk.startsWith("USER#")).toBe(false);
  });

  it("rejects history-sized keys and empty or oversized bodies", () => {
    const now = NOW;
    expect(errorCode(() => buildNotionCacheItem({ segments: [], body: "{}", now }))).toBe("cache_key");
    expect(errorCode(() => buildNotionCacheItem({ segments: ["a", "b", "c", "d", "e"], body: "{}", now }))).toBe(
      "cache_key",
    );
    expect(errorCode(() => buildNotionCacheItem({ segments: ["exercises"], body: "", now }))).toBe("cache_body");
    expect(
      errorCode(() =>
        buildNotionCacheItem({
          segments: ["exercises"],
          body: "x".repeat(LIMITS.cacheBodyLength + 1),
          now,
        }),
      ),
    ).toBe("cache_body");
  });
});

describe("calendar helpers", () => {
  it("adds civil days in UTC so a Lambda in UTC does not shift the date", () => {
    expect(addCalendarDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addCalendarDays("2024-02-28", 2)).toBe("2024-03-01");
  });
});
