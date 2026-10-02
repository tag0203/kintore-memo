/**
 * Single-table contract for kintore-memo (issue #11).
 * Pure helpers: no AWS SDK, no network. Handlers in #6 and #10 should build
 * items here so keys and TTL stay in one place.
 *
 * See docs/dynamodb.md.
 */

export const PARTITION_KEY = "pk";
export const SORT_KEY = "sk";
export const TTL_ATTRIBUTE = "ttl";

export const ENTITY_DAY_PLAN = "DayPlan";
export const ENTITY_NOTION_CACHE = "NotionCache";

/** Shared partition for the optional Notion response cache (one database per deploy). */
export const NOTION_CACHE_PK = "CACHE#notion";

/** Seconds. Cache entries are not source of truth. */
export const NOTION_CACHE_TTL_SECONDS = 300;

/**
 * A DayPlan expires at 00:00 Asia/Tokyo on `date + DAY_PLAN_TTL_DAYS`.
 * `date` itself is a civil day, so this keeps the item through the next Tokyo calendar day.
 */
export const DAY_PLAN_TTL_DAYS = 2;

/** Writes may use Tokyo today, the day before, or the day after (device TZ and midnight). */
export const SESSION_DATE_WINDOW_DAYS = 1;

export const LIMITS = Object.freeze({
  memoLength: 80,
  exerciseNameLength: 80,
  exerciseCount: 40,
  cacheSegments: 4,
  cacheSegmentLength: 80,
  cacheBodyLength: 350_000,
});

const TOKYO_OFFSET_MS = 9 * 60 * 60 * 1000;
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ItemValidationError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "ItemValidationError";
    this.code = code;
  }
}

function invalid(code, message) {
  throw new ItemValidationError(code, message);
}

function hasControlChar(value) {
  return /[\u0000-\u001F\u007F]/.test(value);
}

/**
 * @param {unknown} userId Cognito `sub` claim. Use the token value as-is.
 */
export function assertUserId(userId) {
  if (typeof userId !== "string" || !USER_ID_PATTERN.test(userId)) {
    invalid("user_id", "userId must be the Cognito sub UUID");
  }
  return userId;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function assertIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    invalid("date", "date must be YYYY-MM-DD");
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    invalid("date", "date is not a real calendar day");
  }
  return value;
}

/**
 * @param {unknown} now
 * @returns {Date}
 */
export function assertNow(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    invalid("now", "now must be a Date");
  }
  return now;
}

/**
 * @param {Date} now
 * @returns {string} YYYY-MM-DD in Asia/Tokyo
 */
export function tokyoCivilDate(now) {
  const shifted = new Date(assertNow(now).getTime() + TOKYO_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * @param {string} isoDate
 * @param {number} days
 */
export function addCalendarDays(isoDate, days) {
  const [year, month, day] = assertIsoDate(isoDate).split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  const y = utc.getUTCFullYear();
  const m = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const d = String(utc.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * @param {string} date
 * @param {Date} now
 */
export function isWritableSessionDate(date, now) {
  const today = tokyoCivilDate(now);
  const allowed = new Set([
    addCalendarDays(today, -SESSION_DATE_WINDOW_DAYS),
    today,
    addCalendarDays(today, SESSION_DATE_WINDOW_DAYS),
  ]);
  return allowed.has(assertIsoDate(date));
}

/**
 * Unix epoch seconds. DynamoDB TTL deletes the item at or after this instant.
 * @param {string} isoDate session civil date
 */
export function dayPlanTtlEpochSeconds(isoDate) {
  const [year, month, day] = assertIsoDate(isoDate).split("-").map(Number);
  const expiresUtcMs = Date.UTC(year, month - 1, day + DAY_PLAN_TTL_DAYS) - TOKYO_OFFSET_MS;
  return Math.floor(expiresUtcMs / 1000);
}

/**
 * @param {string} userId
 * @param {string} date
 */
export function dayPlanKey(userId, date) {
  return {
    [PARTITION_KEY]: `USER#${assertUserId(userId)}`,
    [SORT_KEY]: `DAY#${assertIsoDate(date)}`,
  };
}

function normalizeMemo(memo) {
  if (typeof memo !== "string") invalid("memo_invalid", "memo must be a string");
  const stripped = memo.replace(/[\r\n]/g, "");
  if (hasControlChar(stripped)) invalid("memo_invalid", "memo contains control characters");
  if ([...stripped].length > LIMITS.memoLength) {
    invalid("memo_too_long", `memo is longer than ${LIMITS.memoLength} characters`);
  }
  return stripped;
}

function normalizeExerciseName(name) {
  if (typeof name !== "string") invalid("exercise_invalid", "exercise name must be a string");
  const trimmed = name.trim();
  if (!trimmed) invalid("exercise_invalid", "exercise name is empty");
  if ([...trimmed].length > LIMITS.exerciseNameLength) {
    invalid("exercise_too_long", `exercise name is longer than ${LIMITS.exerciseNameLength} characters`);
  }
  if (hasControlChar(trimmed) || trimmed.includes("#")) {
    invalid("exercise_invalid", "exercise name contains a control character or '#'");
  }
  return trimmed;
}

function normalizeExercises(exercises) {
  if (!Array.isArray(exercises)) invalid("exercises_invalid", "exercises must be an array");
  if (exercises.length > LIMITS.exerciseCount) {
    invalid("exercises_too_many", `exercises exceeds ${LIMITS.exerciseCount}`);
  }
  const names = exercises.map(normalizeExerciseName);
  if (new Set(names).size !== names.length) invalid("duplicate_exercise", "exercises contains a duplicate");
  return names;
}

/**
 * Full DayPlan item for PutItem. #6 maps `src/session.tsx` onto this shape.
 * Workout logs (weight, reps, sets, difficulty) are not accepted.
 *
 * @param {{
 *   userId: string,
 *   date: string,
 *   memo: string,
 *   exercises: string[],
 *   finished: boolean,
 *   now: Date,
 * }} input
 */
export function buildDayPlanItem(input) {
  const userId = assertUserId(input.userId);
  const date = assertIsoDate(input.date);
  const now = assertNow(input.now);
  if (!isWritableSessionDate(date, now)) {
    invalid("date_window", "date is outside the writable session window");
  }
  if (typeof input.finished !== "boolean") invalid("finished_invalid", "finished must be a boolean");

  return {
    ...dayPlanKey(userId, date),
    entityType: ENTITY_DAY_PLAN,
    userId,
    date,
    memo: normalizeMemo(input.memo),
    exercises: normalizeExercises(input.exercises),
    finished: input.finished,
    updatedAt: now.toISOString(),
    [TTL_ATTRIBUTE]: dayPlanTtlEpochSeconds(date),
  };
}

/**
 * @param {unknown} item
 */
export function readDayPlanItem(item) {
  if (item == null || typeof item !== "object") invalid("item_invalid", "DayPlan item is missing");
  const record = /** @type {Record<string, unknown>} */ (item);
  if (record.entityType !== ENTITY_DAY_PLAN) invalid("entity_type", "item is not a DayPlan");
  const userId = assertUserId(record.userId);
  const date = assertIsoDate(record.date);
  const key = dayPlanKey(userId, date);
  if (record[PARTITION_KEY] !== key[PARTITION_KEY] || record[SORT_KEY] !== key[SORT_KEY]) {
    invalid("key_mismatch", "DayPlan key does not match userId and date");
  }
  if (typeof record.finished !== "boolean") invalid("finished_invalid", "finished must be a boolean");
  if (typeof record.updatedAt !== "string") invalid("updated_at", "updatedAt must be a string");
  if (record[TTL_ATTRIBUTE] !== dayPlanTtlEpochSeconds(date)) {
    invalid("ttl", "DayPlan ttl does not match the session date");
  }
  return {
    ...key,
    entityType: ENTITY_DAY_PLAN,
    userId,
    date,
    memo: normalizeMemo(record.memo),
    exercises: normalizeExercises(record.exercises),
    finished: record.finished,
    updatedAt: record.updatedAt,
    [TTL_ATTRIBUTE]: dayPlanTtlEpochSeconds(date),
  };
}

/**
 * @param {Date} now
 */
export function notionCacheTtlEpochSeconds(now) {
  return Math.floor(assertNow(now).getTime() / 1000) + NOTION_CACHE_TTL_SECONDS;
}

function normalizeCacheSegments(segments) {
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > LIMITS.cacheSegments) {
    invalid("cache_key", `cache key needs 1 to ${LIMITS.cacheSegments} segments`);
  }
  return segments.map((segment) => {
    if (typeof segment !== "string") invalid("cache_key", "cache segment must be a string");
    const trimmed = segment.trim();
    if (!trimmed || [...trimmed].length > LIMITS.cacheSegmentLength) {
      invalid("cache_key", "cache segment length is out of range");
    }
    if (hasControlChar(trimmed) || trimmed.includes("#")) {
      invalid("cache_key", "cache segment contains a control character or '#'");
    }
    return trimmed;
  });
}

/**
 * @param {string[]} segments
 */
export function notionCacheKey(segments) {
  const cacheKey = normalizeCacheSegments(segments).join("#");
  return {
    [PARTITION_KEY]: NOTION_CACHE_PK,
    [SORT_KEY]: cacheKey,
  };
}

/**
 * Replace-in-place cache entry. The body is an opaque string (JSON text).
 * The same segments overwrite the previous payload. Do not append versions.
 *
 * @param {{ segments: string[], body: string, now: Date }} input
 */
export function buildNotionCacheItem(input) {
  const key = notionCacheKey(input.segments);
  const now = assertNow(input.now);
  if (typeof input.body !== "string" || input.body.length === 0) {
    invalid("cache_body", "cache body must be a non-empty string");
  }
  if (input.body.length > LIMITS.cacheBodyLength) {
    invalid("cache_body", "cache body exceeds the size limit");
  }
  return {
    ...key,
    entityType: ENTITY_NOTION_CACHE,
    cacheKey: key[SORT_KEY],
    body: input.body,
    cachedAt: now.toISOString(),
    [TTL_ATTRIBUTE]: notionCacheTtlEpochSeconds(now),
  };
}

/**
 * @param {unknown} item
 */
export function readNotionCacheItem(item) {
  if (item == null || typeof item !== "object") invalid("item_invalid", "NotionCache item is missing");
  const record = /** @type {Record<string, unknown>} */ (item);
  if (record.entityType !== ENTITY_NOTION_CACHE) invalid("entity_type", "item is not a NotionCache");
  if (record[PARTITION_KEY] !== NOTION_CACHE_PK) invalid("key_mismatch", "NotionCache partition key is wrong");
  if (typeof record.cacheKey !== "string" || record[SORT_KEY] !== record.cacheKey) {
    invalid("key_mismatch", "NotionCache sort key does not match cacheKey");
  }
  if (typeof record.body !== "string" || record.body.length === 0) {
    invalid("cache_body", "cache body must be a non-empty string");
  }
  if (typeof record.cachedAt !== "string") invalid("cached_at", "cachedAt must be a string");
  if (typeof record[TTL_ATTRIBUTE] !== "number") invalid("ttl", "NotionCache ttl must be a number");
  return {
    [PARTITION_KEY]: NOTION_CACHE_PK,
    [SORT_KEY]: record.cacheKey,
    entityType: ENTITY_NOTION_CACHE,
    cacheKey: record.cacheKey,
    body: record.body,
    cachedAt: record.cachedAt,
    [TTL_ATTRIBUTE]: record[TTL_ATTRIBUTE],
  };
}
