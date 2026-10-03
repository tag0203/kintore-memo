/**
 * DayPlan HTTP mapping for issue #6.
 * Keys, TTL, and attribute checks stay in dynamodb.mjs. This module does not
 * import the AWS SDK. The handler passes a store with GetItem / PutItem only.
 *
 * See docs/dynamodb.md.
 */

import {
  ItemValidationError,
  assertIsoDate,
  assertNow,
  assertUserId,
  buildDayPlanItem,
  dayPlanKey,
  isWritableSessionDate,
  readDayPlanItem,
} from "./dynamodb.mjs";

export class DayPlanStorageError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "DayPlanStorageError";
  }
}

/**
 * @param {ReturnType<typeof buildDayPlanItem>} item
 */
function toDto(item) {
  return {
    date: item.date,
    memo: item.memo,
    exercises: [...item.exercises],
    finished: item.finished,
    updatedAt: item.updatedAt,
  };
}

/**
 * @param {string} date
 */
export function emptyDayPlan(date) {
  return {
    date,
    memo: "",
    exercises: [],
    finished: false,
    updatedAt: null,
  };
}

/**
 * JWT authorizer claim. The handler does not verify the token again.
 * @param {unknown} event
 * @returns {string | null}
 */
export function jwtSubject(event) {
  const request = /** @type {{ requestContext?: { authorizer?: { jwt?: { claims?: { sub?: unknown } } } } }} */ (
    event
  );
  const sub = request.requestContext?.authorizer?.jwt?.claims?.sub;
  return typeof sub === "string" && sub.length > 0 ? sub : null;
}

/**
 * @param {{
 *   userId: string,
 *   date: unknown,
 *   store: { get: (key: { pk: string, sk: string }) => Promise<unknown> },
 *   now: Date,
 * }} input
 */
export async function getDayPlan(input) {
  const userId = assertUserId(input.userId);
  const date = assertIsoDate(input.date);
  const now = assertNow(input.now);
  if (!isWritableSessionDate(date, now)) {
    throw new ItemValidationError("date_window", "date is outside the writable session window");
  }
  const item = await input.store.get(dayPlanKey(userId, date));
  if (item == null) return emptyDayPlan(date);
  try {
    return toDto(readDayPlanItem(item));
  } catch (error) {
    if (error instanceof ItemValidationError) {
      throw new DayPlanStorageError("stored DayPlan failed validation");
    }
    throw error;
  }
}

/**
 * Full replace. `userId` is the JWT sub, never a body field.
 * Weight, reps, sets, and difficulty are ignored because they are not DayPlan attributes.
 *
 * @param {{
 *   userId: string,
 *   body: unknown,
 *   store: { put: (item: ReturnType<typeof buildDayPlanItem>) => Promise<void> },
 *   now: Date,
 * }} input
 */
export async function putDayPlan(input) {
  if (input.body == null || typeof input.body !== "object" || Array.isArray(input.body)) {
    throw new ItemValidationError("body_invalid", "body must be an object");
  }
  const body = /** @type {Record<string, unknown>} */ (input.body);
  const item = buildDayPlanItem({
    userId: input.userId,
    date: /** @type {string} */ (body.date),
    memo: /** @type {string} */ (body.memo),
    exercises: /** @type {string[]} */ (body.exercises),
    finished: /** @type {boolean} */ (body.finished),
    now: input.now,
  });
  await input.store.put(item);
  return toDto(item);
}
