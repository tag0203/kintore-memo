import { describe, expect, it } from "vitest";
import { DAY_PLAN_EXERCISE_LIMIT } from "./data/dayPlanClient";
import { DAY_PLAN_EXERCISE_NAME_LIMIT } from "./data/exerciseName";
import { INITIAL_MEMO, INITIAL_PLAN } from "./data/seed";
import { initialMenu, nextExerciseList } from "./session";

describe("initialMenu", () => {
  it("keeps the mock seed when DayPlan is not configured", () => {
    expect(initialMenu(false)).toEqual({ memo: INITIAL_MEMO, exercises: [...INITIAL_PLAN] });
  });

  it("starts empty when the API will restore a DayPlan", () => {
    expect(initialMenu(true)).toEqual({ memo: "", exercises: [] });
  });
});

describe("nextExerciseList", () => {
  it("appends a new name and ignores blanks and duplicates", () => {
    expect(nextExerciseList(["スクワット"], " ベンチプレス ", null)).toEqual({
      result: "added",
      exercises: ["スクワット", "ベンチプレス"],
    });
    expect(nextExerciseList(["スクワット"], "  ", null).result).toBe("empty");
    expect(nextExerciseList(["スクワット"], "スクワット", DAY_PLAN_EXERCISE_LIMIT).result).toBe("present");
  });

  it("stops at the DayPlan limit instead of growing the visible menu", () => {
    const current = Array.from({ length: DAY_PLAN_EXERCISE_LIMIT }, (_, index) => `種目${index}`);
    const blocked = nextExerciseList(current, "種目41", DAY_PLAN_EXERCISE_LIMIT);
    expect(blocked.result).toBe("too_many");
    expect(blocked.exercises).toEqual(current);
    expect(nextExerciseList(current, "種目41", null).result).toBe("added");
  });

  it("rejects names DayPlan cannot store before the menu changes", () => {
    const current = ["スクワット"];
    const hash = nextExerciseList(current, "スクワット#脚", null);
    expect(hash).toEqual({ result: "invalid", exercises: current });
    expect(nextExerciseList(current, "ベンチ\u0007プレス", DAY_PLAN_EXERCISE_LIMIT).result).toBe("invalid");
    const longName = "あ".repeat(DAY_PLAN_EXERCISE_NAME_LIMIT + 1);
    expect(nextExerciseList(current, longName, null)).toEqual({ result: "too_long", exercises: current });
    expect(nextExerciseList(current, "スクワット＃", null).result).toBe("added");
    expect(nextExerciseList(current, "あ".repeat(DAY_PLAN_EXERCISE_NAME_LIMIT), null).result).toBe("added");
  });
});
