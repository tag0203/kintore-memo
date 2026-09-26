import { describe, expect, it } from "vitest";
import type { WorkoutLogClient } from "../src/data/client";
import { handleRequest } from "./index";

function client(partial: Partial<WorkoutLogClient> = {}): WorkoutLogClient {
  return {
    async listExercises() {
      return [{ name: "スクワット", lastPickedAt: null }];
    },
    async listRecentExercises() {
      return [];
    },
    async getPreviousLog() {
      return null;
    },
    async getLogOnDate() {
      return null;
    },
    async createLog(input) {
      return {
        id: "log-1",
        exercise: input.exercise,
        weightKg: input.weightKg,
        reps: input.reps,
        sets: input.sets,
        difficulty: input.difficulty,
        date: input.date,
        title: input.title ?? "－",
        createdAt: "2026-09-26T00:00:00.000Z",
      };
    },
    async touchExercise(name, atISO) {
      return { name, lastPickedAt: atISO };
    },
    ...partial,
  };
}

describe("worker HTTP API", () => {
  it("reports configuration without echoing the token", async () => {
    const response = await handleRequest(new Request("https://app.example/api/health"), {
      NOTION_TOKEN: "test-token",
      NOTION_DATABASE_ID: "db-1",
    });
    const body = (await response.json()) as { ok: boolean; notionConfigured: boolean };
    expect(body).toEqual({ ok: true, notionConfigured: true });
    expect(JSON.stringify(body)).not.toContain("test-token");
  });

  it("creates a log through the injected client", async () => {
    let created = 0;
    const response = await handleRequest(
      new Request("https://app.example/api/logs", {
        method: "POST",
        body: JSON.stringify({
          exercise: "スクワット",
          weightKg: 82.5,
          reps: 11,
          sets: 3,
          difficulty: 3,
          date: "2026-09-26",
        }),
      }),
      {},
      {
        createClient: () =>
          client({
            async createLog(input) {
              created += 1;
              return {
                id: "log-1",
                exercise: input.exercise,
                weightKg: input.weightKg,
                reps: input.reps,
                sets: input.sets,
                difficulty: input.difficulty,
                date: input.date,
                title: input.title ?? "－",
                createdAt: "2026-09-26T00:00:00.000Z",
              };
            },
          }),
      },
    );
    expect(response.status).toBe(201);
    expect(created).toBe(1);
    const body = (await response.json()) as { exercise: string; weightKg: number; title: string };
    expect(body).toMatchObject({ exercise: "スクワット", weightKg: 82.5, title: "－" });
  });

  it.each([
    { weightKg: -20, reps: 11, sets: 3 },
    { weightKg: 80, reps: 1.5, sets: 3 },
    { weightKg: 80, reps: 11, sets: 0 },
    { weightKg: 0, reps: 11, sets: 3 },
    { weightKg: 1000, reps: 11, sets: 3 },
    { weightKg: 80, reps: 1000, sets: 3 },
  ])("rejects %j before creating a Notion row", async (override) => {
    let created = 0;
    const response = await handleRequest(
      new Request("https://app.example/api/logs", {
        method: "POST",
        body: JSON.stringify({
          exercise: "スクワット",
          difficulty: 3,
          date: "2026-09-26",
          ...override,
        }),
      }),
      {},
      {
        createClient: () =>
          client({
            async createLog() {
              created += 1;
              throw new Error("Notion create should not run");
            },
          }),
      },
    );
    expect(response.status).toBe(400);
    expect(created).toBe(0);
  });

  it("rejects an unknown route", async () => {
    const response = await handleRequest(new Request("https://app.example/secret"), {});
    expect(response.status).toBe(404);
  });
});
