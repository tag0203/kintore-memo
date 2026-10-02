import { describe, expect, it } from "vitest";
import { createMemoryNotionCache } from "./notionCache.mjs";
import { createNotionService } from "./notionService.mjs";

function log(overrides) {
  return {
    id: "page-1",
    exercise: "スクワット",
    weightKg: 80,
    reps: 11,
    sets: 3,
    difficulty: 3,
    date: "2026-09-25",
    title: "－",
    createdAt: "2026-09-25T12:00:00.000Z",
    ...overrides,
  };
}

function fakeClient(options = {}) {
  const calls = [];
  const window = options.window ?? { logs: [log()], complete: true };
  return {
    calls,
    async listExercises() {
      calls.push("exercises");
      return [{ name: "スクワット", lastPickedAt: null }, { name: "デッドリフト", lastPickedAt: null }];
    },
    async loadRecentWindow() {
      calls.push("recent");
      return window;
    },
    async getPreviousLog(exercise, before) {
      calls.push(`previous:${exercise}:${before}`);
      return log({ id: "old", exercise, date: "2026-01-01" });
    },
    async getLogOnDate(exercise, date) {
      calls.push(`today:${exercise}:${date}`);
      return null;
    },
    async createLog(input) {
      calls.push("create");
      return { ...log(), ...input, id: "new", createdAt: "2026-10-02T01:00:00.000Z" };
    },
  };
}

function serviceFor(client) {
  return createNotionService({ client, cache: createMemoryNotionCache({ now: () => new Date("2026-10-02T00:00:00.000Z") }) });
}

describe("notion service cache", () => {
  it("loads the catalog and the recent window once for repeated bootstraps", async () => {
    const client = fakeClient();
    const service = serviceFor(client);
    const first = await service.bootstrap("2026-10-02", ["スクワット"]);
    const second = await service.bootstrap("2026-10-02", ["スクワット"]);
    expect(first.logs["スクワット"].previous).toMatchObject({ date: "2026-09-25" });
    expect(first.logs["スクワット"].today).toBeNull();
    expect(second).toEqual(first);
    expect(client.calls).toEqual(["exercises", "recent"]);
  });

  it("shares one in-flight window across concurrent bootstraps", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const client = fakeClient();
    const inner = client.loadRecentWindow.bind(client);
    client.loadRecentWindow = async () => {
      await gate;
      return inner();
    };
    const service = serviceFor(client);
    const pending = Promise.all([
      service.bootstrap("2026-10-02", []),
      service.bootstrap("2026-10-02", []),
    ]);
    release();
    const [first, second] = await pending;
    expect(second.recent).toEqual(first.recent);
    expect(client.calls.filter((call) => call === "recent")).toEqual(["recent"]);
  });

  it("queries Notion for a cold exercise only when the window cannot prove it", async () => {
    const client = fakeClient({
      window: { logs: [log({ date: "2026-10-01" })], complete: false },
    });
    const service = serviceFor(client);
    const body = await service.bootstrap("2026-10-02", ["デッドリフト"]);
    expect(body.logs["デッドリフト"].previous).toMatchObject({ exercise: "デッドリフト", date: "2026-01-01" });
    expect(body.logs["デッドリフト"].today).toBeNull();
    expect(client.calls).toContain("previous:デッドリフト:2026-10-02");
    expect(client.calls).not.toContain("today:デッドリフト:2026-10-02");

    client.calls.length = 0;
    await service.getPreviousLog("デッドリフト", "2026-10-02");
    expect(client.calls).toEqual([]);
  });

  it("drops the window after a save so the next read hits Notion", async () => {
    const client = fakeClient();
    const service = serviceFor(client);
    await service.listRecentExercises();
    await service.createLog({
      exercise: "スクワット",
      weightKg: 82.5,
      reps: 8,
      sets: 3,
      difficulty: 4,
      date: "2026-10-02",
    });
    client.calls.length = 0;
    await service.listRecentExercises();
    expect(client.calls).toEqual(["recent"]);
  });
});
