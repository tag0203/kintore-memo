import { describe, expect, it, vi } from "vitest";
import { DAY_PLAN_EXERCISE_LIMIT } from "../data/dayPlanClient";
import { nextExerciseList } from "../session";
import { exerciseChoice } from "./PickerScreen";
import { persistRecordedExercise } from "./RecordScreen";

describe("persistRecordedExercise", () => {
  it("adds the exercise and touches it with the saved log's createdAt", async () => {
    const order: string[] = [];
    await persistRecordedExercise({
      exercise: "ベンチプレス",
      date: "2026-10-09",
      createLog: async () => {
        order.push("log");
        return { createdAt: "2026-10-09T03:04:05.000Z" };
      },
      addExercise: (name) => {
        order.push(`add:${name}`);
      },
      touchExercise: async (name, atISO, onDate) => {
        order.push(`touch:${name}:${atISO}:${onDate}`);
      },
    });
    expect(order).toEqual([
      "log",
      "add:ベンチプレス",
      "touch:ベンチプレス:2026-10-09T03:04:05.000Z:2026-10-09",
    ]);
  });

  it("does not add or touch when the log is not saved", async () => {
    const addExercise = vi.fn();
    const touchExercise = vi.fn();
    await expect(
      persistRecordedExercise({
        exercise: "ベンチプレス",
        date: "2026-10-10",
        createLog: async () => {
          throw new Error("保存に失敗しました");
        },
        addExercise,
        touchExercise,
      }),
    ).rejects.toThrow("保存に失敗しました");
    expect(addExercise).not.toHaveBeenCalled();
    expect(touchExercise).not.toHaveBeenCalled();
  });

  it("keeps the saved log when touching recent exercises fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const addExercise = vi.fn();
    const reason = new Error("最近の更新に失敗しました");
    await expect(
      persistRecordedExercise({
        exercise: "スクワット",
        date: "2026-10-08",
        createLog: async () => ({ createdAt: "2026-10-08T01:00:00.000Z" }),
        addExercise,
        touchExercise: async () => {
          throw reason;
        },
      }),
    ).resolves.toBeUndefined();
    expect(addExercise).toHaveBeenCalledWith("スクワット");
    expect(logged).toHaveBeenCalledWith("touch exercise failed", reason);
    logged.mockRestore();
  });

  it("does not drop an exercise that is already on the menu", async () => {
    let menu = ["スクワット", "ベンチプレス"];
    const choice = exerciseChoice("スクワット", menu, DAY_PLAN_EXERCISE_LIMIT);
    expect(choice).toEqual({ type: "record", exercise: "スクワット" });
    expect(menu).toEqual(["スクワット", "ベンチプレス"]);

    await persistRecordedExercise({
      exercise: "スクワット",
      date: "2026-10-10",
      createLog: async () => ({ createdAt: "2026-10-10T00:00:00.000Z" }),
      addExercise: (name) => {
        const decision = nextExerciseList(menu, name, DAY_PLAN_EXERCISE_LIMIT);
        if (decision.result === "added") menu = decision.exercises;
      },
      touchExercise: async () => {},
    });
    expect(menu).toEqual(["スクワット", "ベンチプレス"]);
  });

  it("appends a new exercise only after the log is saved", async () => {
    let menu = ["スクワット"];
    const choice = exerciseChoice("ベンチプレス", menu, DAY_PLAN_EXERCISE_LIMIT);
    expect(choice).toEqual({ type: "record", exercise: "ベンチプレス" });
    expect(menu).toEqual(["スクワット"]);

    await persistRecordedExercise({
      exercise: "ベンチプレス",
      date: "2026-10-10",
      createLog: async () => ({ createdAt: "2026-10-10T08:00:00.000Z" }),
      addExercise: (name) => {
        const decision = nextExerciseList(menu, name, DAY_PLAN_EXERCISE_LIMIT);
        if (decision.result === "added") menu = decision.exercises;
      },
      touchExercise: async () => {},
    });
    expect(menu).toEqual(["スクワット", "ベンチプレス"]);
  });
});
