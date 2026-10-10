import { describe, expect, it, vi } from "vitest";
import { DAY_PLAN_EXERCISE_LIMIT, type DayPlanInput } from "./data/dayPlanClient";
import { createDayPlanSaver } from "./data/dayPlanSync";
import { DAY_PLAN_EXERCISE_NAME_LIMIT } from "./data/exerciseName";
import { INITIAL_MEMO, INITIAL_PLAN } from "./data/seed";
import { initialMenu, nextExerciseList, removalSnapshot, withoutExercise } from "./session";

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

describe("withoutExercise", () => {
  it("drops one name and keeps the rest in order", () => {
    const current = ["スクワット", "ベンチプレス", "デッドリフト"];
    expect(withoutExercise(current, "ベンチプレス", false)).toEqual({
      result: "removed",
      exercises: ["スクワット", "デッドリフト"],
    });
    expect(current).toEqual(["スクワット", "ベンチプレス", "デッドリフト"]);
  });

  it("trims the name and leaves the list when it is missing", () => {
    const current = ["スクワット"];
    expect(withoutExercise(current, " スクワット ", false)).toEqual({ result: "removed", exercises: [] });
    expect(withoutExercise(current, "ベンチプレス", false)).toEqual({ result: "absent", exercises: current });
    expect(withoutExercise(current, "  ", false).result).toBe("absent");
  });

  it("does not change a finished menu until the day is resumed", () => {
    const current = ["スクワット", "ベンチプレス"];
    expect(withoutExercise(current, "スクワット", true)).toEqual({
      result: "finished",
      exercises: [...current],
    });
  });
});

/** removeExercise と同じ removalSnapshot を saver.schedule する。 */
function publishRemoval(
  saver: ReturnType<typeof createDayPlanSaver>,
  menu: DayPlanInput,
  name: string,
): DayPlanInput {
  const decision = removalSnapshot(menu, name);
  if (!decision.menu) return menu;
  const next = { ...menu, ...decision.menu };
  saver.schedule(next);
  return next;
}

describe("removing an exercise saves the DayPlan", () => {
  it("puts the whole remaining menu, including an empty list", async () => {
    const save = vi.fn(async () => {});
    const saver = createDayPlanSaver(save, { waitMs: 10_000 });
    const menu: DayPlanInput = {
      date: "2026-10-02",
      memo: "脚",
      exercises: ["スクワット", "ベンチプレス"],
      finished: false,
    };
    saver.markSaved(menu);

    const afterFirst = publishRemoval(saver, menu, "スクワット");
    await saver.flush();
    const afterSecond = publishRemoval(saver, afterFirst, "ベンチプレス");
    await saver.flush();

    expect(save).toHaveBeenNthCalledWith(1, {
      date: "2026-10-02",
      memo: "脚",
      exercises: ["ベンチプレス"],
      finished: false,
    });
    expect(save).toHaveBeenNthCalledWith(2, {
      date: "2026-10-02",
      memo: "脚",
      exercises: [],
      finished: false,
    });
    expect(afterSecond.exercises).toEqual([]);
  });

  it("does not write when the day is finished or the name is absent", async () => {
    const save = vi.fn(async () => {});
    const saver = createDayPlanSaver(save, { waitMs: 10_000 });
    const finished: DayPlanInput = {
      date: "2026-10-02",
      memo: "脚",
      exercises: ["スクワット"],
      finished: true,
    };
    saver.markSaved(finished);
    publishRemoval(saver, finished, "スクワット");
    publishRemoval(saver, { ...finished, finished: false }, "ない種目");
    await saver.flush();
    expect(save).not.toHaveBeenCalled();
  });

  it("drops a removal whose session epoch no longer matches", async () => {
    let epoch = 1;
    const save = vi.fn(async () => {});
    const saver = createDayPlanSaver(save, { waitMs: 10_000, allowWrite: () => epoch === 1 });
    const menu: DayPlanInput = {
      date: "2026-10-02",
      memo: "",
      exercises: ["スクワット"],
      finished: false,
    };
    saver.markSaved(menu);
    epoch = 2;
    publishRemoval(saver, menu, "スクワット");
    await saver.flush();
    expect(save).not.toHaveBeenCalled();
  });
});
