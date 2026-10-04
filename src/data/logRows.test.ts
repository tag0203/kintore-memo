import { describe, expect, it } from "vitest";
import type { ExerciseLog } from "../domain";
import { logsOnDate, previousDayLogs } from "./logRows";

function row(partial: Partial<ExerciseLog> & Pick<ExerciseLog, "id" | "exercise" | "date" | "weightKg">): ExerciseLog {
  return {
    reps: 8,
    sets: 3,
    difficulty: 3,
    title: "－",
    createdAt: `${partial.date}T00:00:00.000Z`,
    ...partial,
  };
}

const logs = [
  row({ id: "old", exercise: "スクワット", date: "2026-09-10", weightKg: 40, createdAt: "2026-09-10T09:00:00.000Z" }),
  row({ id: "s60", exercise: "スクワット", date: "2026-09-25", weightKg: 60, createdAt: "2026-09-25T11:00:00.000Z" }),
  row({ id: "s70", exercise: "スクワット", date: "2026-09-25", weightKg: 70, difficulty: 4, createdAt: "2026-09-25T12:00:00.000Z" }),
  row({ id: "press", exercise: "レッグプレス", date: "2026-09-28", weightKg: 150, createdAt: "2026-09-28T10:00:00.000Z" }),
  row({ id: "t80", exercise: "スクワット", date: "2026-10-02", weightKg: 80, createdAt: "2026-10-02T08:00:00.000Z" }),
  row({ id: "t90", exercise: "スクワット", date: "2026-10-02", weightKg: 90, createdAt: "2026-10-02T09:00:00.000Z" }),
];

describe("previous and today rows", () => {
  it("returns every row from that exercise's last day before today", () => {
    expect(previousDayLogs(logs, "スクワット", "2026-10-02").map((log) => log.weightKg)).toEqual([60, 70]);
    expect(previousDayLogs(logs, "レッグプレス", "2026-10-02").map((log) => log.date)).toEqual(["2026-09-28"]);
    expect(logsOnDate(logs, "スクワット", "2026-10-02").map((log) => log.id)).toEqual(["t80", "t90"]);
  });

  it("does not let today's rows replace the previous day", () => {
    const previous = previousDayLogs(logs, "スクワット", "2026-10-02");
    expect(previous.every((log) => log.date === "2026-09-25")).toBe(true);
    expect(previous.map((log) => log.id)).not.toContain("t90");
  });
});
