import { describe, expect, it } from "vitest";
import { PAGE_TITLE } from "../domain";
import { createMockClient } from "./mockClient";
import { createSeed } from "./seed";

const today = new Date(2026, 8, 26);

describe("mock workout client", () => {
  it("seeds the home list: previous day for squat, today already logged for leg curl", async () => {
    const client = createMockClient(createSeed(today));

    await expect(client.getPreviousLog("スクワット", "2026-09-26")).resolves.toMatchObject({
      weightKg: 80,
      reps: 11,
      sets: 3,
      difficulty: 3,
      date: "2026-09-25",
    });

    await expect(client.getLogOnDate("レッグカール", "2026-09-26")).resolves.toMatchObject({
      id: "seed-curl-today",
      weightKg: 40,
      reps: 12,
      sets: 3,
    });
    await expect(client.getPreviousLog("レッグカール", "2026-09-26")).resolves.toMatchObject({
      weightKg: 40,
      date: "2026-09-20",
    });

    const recent = await client.listRecentExercises();
    expect(recent.map((exercise) => exercise.name).slice(0, 3)).toEqual([
      "スクワット",
      "レッグプレス",
      "ベンチプレス",
    ]);
  });

  it("appends a row and keeps the previous day as 前回", async () => {
    const client = createMockClient(createSeed(today));
    const created = await client.createLog({
      exercise: "スクワット",
      weightKg: 82.5,
      reps: 8,
      sets: 3,
      difficulty: 4,
      date: "2026-09-26",
    });

    expect(created.title).toBe(PAGE_TITLE);
    await expect(client.getPreviousLog("スクワット", "2026-09-26")).resolves.toMatchObject({
      weightKg: 80,
    });
    await expect(client.getLogOnDate("スクワット", "2026-09-26")).resolves.toMatchObject({
      weightKg: 82.5,
      difficulty: 4,
    });
  });

  it("adds a new exercise name to the catalog", async () => {
    const client = createMockClient(createSeed(today));
    await client.touchExercise("ショルダープレス", "2026-09-26T09:00:00.000Z");
    const names = (await client.listExercises()).map((exercise) => exercise.name);
    expect(names).toContain("ショルダープレス");
    await expect(client.touchExercise("  ", "2026-09-26T09:00:00.000Z")).rejects.toThrow(
      "種目名を入力してください",
    );
    await expect(client.touchExercise("スクワット#脚", "2026-09-26T09:00:00.000Z")).rejects.toThrow(
      "種目名を確認してください",
    );
    await expect(client.touchExercise("ベンチ\u0007プレス", "2026-09-26T09:00:00.000Z")).rejects.toThrow(
      "種目名を確認してください",
    );
  });
});
