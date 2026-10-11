import { describe, expect, it } from "vitest";
import { DAY_PLAN_EXERCISE_LIMIT, DAY_PLAN_TOO_MANY_EXERCISES } from "../data/dayPlanClient";
import { DAY_PLAN_EXERCISE_INVALID, DAY_PLAN_EXERCISE_TOO_LONG } from "../data/exerciseName";
import { exerciseChoice } from "./PickerScreen";

describe("exerciseChoice", () => {
  it("opens the record screen and leaves the menu unchanged", () => {
    const menu = ["スクワット"];
    expect(exerciseChoice(" ベンチプレス ", menu, DAY_PLAN_EXERCISE_LIMIT)).toEqual({
      type: "record",
      exercise: "ベンチプレス",
    });
    expect(menu).toEqual(["スクワット"]);
  });

  it("keeps an exercise that is already on the menu", () => {
    const menu = ["スクワット", "ベンチプレス"];
    expect(exerciseChoice("ベンチプレス", menu, DAY_PLAN_EXERCISE_LIMIT)).toEqual({
      type: "record",
      exercise: "ベンチプレス",
    });
    expect(menu).toEqual(["スクワット", "ベンチプレス"]);
  });

  it("still opens an exercise that is already on a full menu", () => {
    const menu = Array.from({ length: DAY_PLAN_EXERCISE_LIMIT }, (_, index) => `種目${index}`);
    expect(exerciseChoice(menu[0], menu, DAY_PLAN_EXERCISE_LIMIT)).toEqual({
      type: "record",
      exercise: menu[0],
    });
    expect(menu).toHaveLength(DAY_PLAN_EXERCISE_LIMIT);
  });

  it("rejects an invalid name, a too-long name, and a new name past the limit", () => {
    expect(exerciseChoice("スクワット#脚", ["スクワット"], DAY_PLAN_EXERCISE_LIMIT)).toEqual({
      type: "error",
      message: DAY_PLAN_EXERCISE_INVALID,
    });
    expect(exerciseChoice(`ベンチ${"\u0007"}プレス`, ["スクワット"], null)).toEqual({
      type: "error",
      message: DAY_PLAN_EXERCISE_INVALID,
    });
    expect(exerciseChoice("あ".repeat(81), ["スクワット"], null)).toEqual({
      type: "error",
      message: DAY_PLAN_EXERCISE_TOO_LONG,
    });
    const full = Array.from({ length: DAY_PLAN_EXERCISE_LIMIT }, (_, index) => `種目${index}`);
    expect(exerciseChoice("新しい種目", full, DAY_PLAN_EXERCISE_LIMIT)).toEqual({
      type: "error",
      message: DAY_PLAN_TOO_MANY_EXERCISES,
    });
    expect(full).toHaveLength(DAY_PLAN_EXERCISE_LIMIT);
  });

  it("does not apply the cap when the menu has no limit", () => {
    const full = Array.from({ length: DAY_PLAN_EXERCISE_LIMIT }, (_, index) => `種目${index}`);
    expect(exerciseChoice("新しい種目", full, null)).toEqual({
      type: "record",
      exercise: "新しい種目",
    });
    expect(full).toHaveLength(DAY_PLAN_EXERCISE_LIMIT);
  });

  it("ignores a blank name", () => {
    const menu = ["スクワット"];
    expect(exerciseChoice("   ", menu, DAY_PLAN_EXERCISE_LIMIT)).toEqual({ type: "ignore" });
    expect(menu).toEqual(["スクワット"]);
  });
});
