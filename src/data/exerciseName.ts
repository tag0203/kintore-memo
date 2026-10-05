/**
 * DayPlan exercise names follow docs/dynamodb.md and api/internal/ddb:
 * trimmed, at most 80 code points, no C0/DEL controls, no "#".
 * The picker still caps new names at 40 UTF-16 units.
 */

export const DAY_PLAN_EXERCISE_NAME_LIMIT = 80;

export const DAY_PLAN_EXERCISE_INVALID = "種目名を確認してください";

export const DAY_PLAN_EXERCISE_TOO_LONG = "種目名が長すぎます";

const CONTROL_CHAR = /[\u0000-\u001F\u007F]/;

export function dayPlanExerciseNameIssue(name: string): "invalid" | "too_long" | null {
  const trimmed = name.trim();
  if (!trimmed) return "invalid";
  if ([...trimmed].length > DAY_PLAN_EXERCISE_NAME_LIMIT) return "too_long";
  if (CONTROL_CHAR.test(trimmed) || trimmed.includes("#")) return "invalid";
  return null;
}

/** Screen catalog check. Rejects names DayPlan and Notion cache keys cannot store. */
export function assertCatalogName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("種目名を入力してください");
  if (trimmed.length > 40) throw new Error("種目名は40文字以内にしてください");
  const issue = dayPlanExerciseNameIssue(trimmed);
  if (issue === "too_long") throw new Error(DAY_PLAN_EXERCISE_TOO_LONG);
  if (issue) throw new Error(DAY_PLAN_EXERCISE_INVALID);
  return trimmed;
}
