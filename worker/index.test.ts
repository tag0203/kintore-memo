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
      return [];
    },
    async getLogOnDate() {
      return [];
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
  it("returns only ok and does not echo the token or configuration", async () => {
    const response = await handleRequest(new Request("https://app.example/api/health"), {
      NOTION_TOKEN: "test-token",
      NOTION_DATABASE_ID: "db-1",
    });
    const body = (await response.json()) as { ok: boolean };
    expect(body).toEqual({ ok: true });
    expect(JSON.stringify(body)).not.toContain("test-token");
    expect(JSON.stringify(body)).not.toContain("notionConfigured");
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

  it("hides notion and configuration details", async () => {
    const notionId = "a1b2c3d4-e5f6-4789-a123-ef1234567890";
    const upstream = await handleRequest(new Request("https://app.example/api/exercises"), {}, {
      createClient: () =>
        client({
          async listExercises() {
            throw new Error(`Notion API: missing database ${notionId} https://example.invalid/db/${notionId}`);
          },
        }),
    });
    expect(upstream.status).toBe(502);
    const upstreamText = await upstream.text();
    expect(upstreamText).toContain("Notion との通信に失敗しました");
    expect(upstreamText).not.toContain(notionId);
    expect(upstreamText).not.toContain("example.invalid");

    const missing = await handleRequest(new Request("https://app.example/api/exercises"), {}, {
      createClient: () =>
        client({
          async listExercises() {
            throw new Error("NOTION_TOKEN が設定されていません");
          },
        }),
    });
    expect(missing.status).toBe(500);
    const missingText = await missing.text();
    expect(missingText).toContain("サーバーでエラーが発生しました");
    expect(missingText).not.toContain("NOTION_TOKEN");
  });

  it("rejects an unknown route", async () => {
    const response = await handleRequest(new Request("https://app.example/secret"), {});
    expect(response.status).toBe(404);
  });
});
