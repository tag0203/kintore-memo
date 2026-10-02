/**
 * Request checks for the Lambda Notion API.
 * Bounds match the screen rules in src/domain.ts (weight, reps, sets, difficulty, date).
 * Exercise names also have to be safe NotionCache segments (issue #11): no "#" or controls.
 */

export class RequestValidationError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "RequestValidationError";
    this.statusCode = 400;
  }
}

function fail(message) {
  throw new RequestValidationError(message);
}

export function isISODate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

/** 0 < weight <= 999, at most two decimal places. */
export function isValidWeightKg(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 999) return false;
  const cents = Math.round(value * 100);
  return Math.abs(value * 100 - cents) < 1e-6;
}

/** Integer 1..999. */
export function isValidCount(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 999;
}

export function isDifficulty(value) {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

export function assertExerciseName(value) {
  if (typeof value !== "string") fail("種目名を確認してください");
  const name = value.trim();
  const length = [...name].length;
  if (!name || length > 80) fail("種目名を確認してください");
  if (/[\u0000-\u001F\u007F]/.test(name) || name.includes("#")) fail("種目名を確認してください");
  return name;
}

export function assertISODate(value, label) {
  if (!isISODate(value)) fail(`${label} は YYYY-MM-DD で指定してください`);
  return value;
}

/**
 * @param {unknown} value
 */
export function readCreateBody(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("記録の形式を確認してください");
  const body = /** @type {Record<string, unknown>} */ (value);
  const exercise = assertExerciseName(body.exercise);
  if (!isValidWeightKg(body.weightKg)) fail("重量を確認してください");
  if (!isValidCount(body.reps)) fail("回数を確認してください");
  if (!isValidCount(body.sets)) fail("セット数を確認してください");
  if (!isDifficulty(body.difficulty)) fail("きつさを確認してください");
  const date = assertISODate(body.date, "日付");

  let title;
  if (body.title !== undefined) {
    if (typeof body.title !== "string") fail("タイトルを確認してください");
    const trimmed = body.title.trim();
    if ([...trimmed].length > 200) fail("タイトルを確認してください");
    if (/[\u0000-\u001F\u007F]/.test(trimmed)) fail("タイトルを確認してください");
    title = trimmed || undefined;
  }

  return {
    exercise,
    weightKg: Math.round(/** @type {number} */ (body.weightKg) * 100) / 100,
    reps: /** @type {number} */ (body.reps),
    sets: /** @type {number} */ (body.sets),
    difficulty: /** @type {1|2|3|4|5} */ (body.difficulty),
    date,
    title,
  };
}

/** Comma-separated and repeated names. At most 40, the day-plan menu cap. */
export function parseExerciseList(values) {
  const names = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    for (const part of value.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      names.push(assertExerciseName(trimmed));
    }
  }
  if (names.length > 40) fail("種目は40件までです");
  return [...new Set(names)];
}
