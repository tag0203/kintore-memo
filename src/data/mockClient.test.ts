import { describe, expect, it } from "vitest";
import { PAGE_TITLE, tokyoCivilDate } from "../domain";
import { createMockClient } from "./mockClient";
import { createSeed } from "./seed";

/** 2026-09-26 12:00 JST。端末のタイムゾーンに依存しない。 */
const today = new Date("2026-09-26T03:00:00.000Z");

describe("createSeed", () => {
  it("uses the Tokyo civil date across the UTC midnight boundary", () => {
    const justAfterTokyoMidnight = new Date("2026-10-02T15:30:00.000Z");
    expect(tokyoCivilDate(justAfterTokyoMidnight)).toBe("2026-10-03");
    const seed = createSeed(justAfterTokyoMidnight);
    const todayLogs = seed.logs.filter((log) => log.id.startsWith("seed-curl-today"));
    expect(todayLogs.map((log) => log.date)).toEqual(["2026-10-03", "2026-10-03"]);
    expect(seed.logs.find((log) => log.id === "seed-squat")?.date).toBe("2026-10-02");
  });
});

describe("mock workout client", () => {
  it("seeds the home list: previous day for squat, today already logged for leg curl", async () => {
    const client = createMockClient(createSeed(today));

    await expect(client.getPreviousLog("スクワット", "2026-09-26")).resolves.toMatchObject([
      { id: "seed-squat-light", weightKg: 60, reps: 8, sets: 3, difficulty: 3, date: "2026-09-25" },
      { id: "seed-squat", weightKg: 80, reps: 11, sets: 3, difficulty: 4, date: "2026-09-25" },
    ]);

    await expect(client.getLogOnDate("レッグカール", "2026-09-26")).resolves.toMatchObject([
      { id: "seed-curl-today", weightKg: 40, reps: 12, sets: 3 },
      { id: "seed-curl-today-heavy", weightKg: 45, reps: 10, sets: 3 },
    ]);
    await expect(client.getPreviousLog("レッグカール", "2026-09-26")).resolves.toMatchObject([
      { weightKg: 40, date: "2026-09-20" },
    ]);

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
    const heavier = await client.createLog({
      exercise: "スクワット",
      weightKg: 90,
      reps: 6,
      sets: 3,
      difficulty: 5,
      date: "2026-09-26",
    });
    await expect(client.getPreviousLog("スクワット", "2026-09-26")).resolves.toMatchObject([
      { id: "seed-squat-light", weightKg: 60 },
      { id: "seed-squat", weightKg: 80 },
    ]);
    const todayLogs = await client.getLogOnDate("スクワット", "2026-09-26");
    expect(todayLogs.map((log) => log.id)).toEqual([created.id, heavier.id]);
    expect(todayLogs.map((log) => log.weightKg)).toEqual([82.5, 90]);
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
