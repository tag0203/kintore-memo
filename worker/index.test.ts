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
    const response = await handleRequest(
      new Request("https://app.example/api/logs", {
        method: "POST",
        body: JSON.stringify({
          exercise: "スクワット",
          weightKg: 80,
          reps: 11,
          sets: 3,
          difficulty: 3,
          date: "2026-09-26",
        }),
      }),
      {},
      { createClient: () => client() },
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { exercise: string; title: string };
    expect(body).toMatchObject({ exercise: "スクワット", title: "－" });
  });

  it("rejects an unknown route", async () => {
    const response = await handleRequest(new Request("https://app.example/secret"), {});
    expect(response.status).toBe(404);
  });
});
