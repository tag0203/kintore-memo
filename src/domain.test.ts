import { describe, expect, it } from "vitest";
import {
  addDays,
  difficultyFromLabel,
  formatJapaneseDate,
  formatMonthDay,
  formatLogLine,
  formatSetSummary,
  parseCount,
  parseWeight,
} from "./domain";

describe("dates and labels", () => {
  it("formats dates the way the home screen shows them", () => {
    expect(formatJapaneseDate("2026-09-26")).toBe("2026/9/26");
    expect(formatMonthDay("2026-09-05")).toBe("9/5");
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-09-26", -1)).toBe("2026-09-25");
  });

  it("maps the five difficulty labels", () => {
    expect(difficultyFromLabel("ややきつい")).toBe(3);
    expect(difficultyFromLabel("不明")).toBeNull();
  });

  it("parses weight and counts", () => {
    expect(parseWeight("80")).toBe(80);
    expect(parseWeight("82.5")).toBe(82.5);
    expect(parseWeight("82,5")).toBe(82.5);
    expect(parseWeight("0")).toBeNull();
    expect(parseWeight("-20")).toBeNull();
    expect(parseWeight("1000")).toBeNull();
    expect(parseWeight("1.234")).toBeNull();
    expect(parseCount("11")).toBe(11);
    expect(parseCount("0")).toBeNull();
    expect(parseCount("1.5")).toBeNull();
    expect(parseCount("1000")).toBeNull();
  });

  it("summarizes a previous set", () => {
    expect(formatSetSummary({ weightKg: 80, reps: 11, sets: 3 })).toBe("80kg × 11 × 3");
    expect(formatSetSummary({ weightKg: 82.5, reps: 8, sets: 3 })).toBe("82.5kg × 8 × 3");
    expect(formatLogLine({ weightKg: 70, reps: 6, sets: 3, difficulty: 4 })).toBe("70kg × 6 × 3 · きつい");
  });
});
