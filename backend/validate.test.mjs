import { describe, expect, it } from "vitest";
import { RequestValidationError, parseExerciseList, readCreateBody } from "./validate.mjs";

const valid = {
  exercise: " スクワット ",
  weightKg: 82.5,
  reps: 11,
  sets: 3,
  difficulty: 3,
  date: "2026-10-02",
};

describe("readCreateBody", () => {
  it("trims the exercise and keeps a screen-legal set", () => {
    expect(readCreateBody(valid)).toMatchObject({ exercise: "スクワット", weightKg: 82.5, title: undefined });
  });

  it.each([
    { weightKg: -20 },
    { weightKg: 0 },
    { weightKg: 1000 },
    { weightKg: 80.555 },
    { reps: 1.5 },
    { reps: 0 },
    { reps: 1000 },
    { sets: 0 },
    { difficulty: 6 },
    { date: "2026-02-31" },
    { exercise: "" },
    { exercise: "スクワット#1" },
    { title: 1 },
  ])("rejects %j", (override) => {
    expect(() => readCreateBody({ ...valid, ...override })).toThrow(RequestValidationError);
  });
});

describe("parseExerciseList", () => {
  it("splits commas, repeats, and drops blanks", () => {
    expect(parseExerciseList(["スクワット, ベンチプレス", "スクワット", ""])).toEqual([
      "スクワット",
      "ベンチプレス",
    ]);
  });

  it("rejects more than 40 names", () => {
    const names = Array.from({ length: 41 }, (_, index) => `種目${index}`);
    expect(() => parseExerciseList([names.join(",")] )).toThrow("40");
  });
});
