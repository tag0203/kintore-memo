import { describe, expect, it, vi } from "vitest";
import type { ExerciseLog } from "../domain";
import { createHttpWorkoutClient } from "./httpClient";

const date = "2026-10-02";

function log(partial: Partial<ExerciseLog> & Pick<ExerciseLog, "id" | "exercise" | "date">): ExerciseLog {
  return {
    weightKg: 80,
    reps: 8,
    sets: 3,
    difficulty: 3,
    title: "－",
    createdAt: `${partial.date}T00:00:00.000Z`,
    ...partial,
  };
}

const squatPrevious = log({
  id: "squat-prev",
  exercise: "スクワット",
  weightKg: 80,
  date: "2026-09-25",
  createdAt: "2026-09-25T12:00:00.000Z",
});

const benchPrevious = log({
  id: "bench-prev",
  exercise: "ベンチプレス",
  weightKg: 60,
  date: "2026-09-20",
  createdAt: "2026-09-20T10:00:00.000Z",
});

interface Call {
  url: string;
  method: string;
  authorization: string | null;
  body: string | null;
}

function installApi() {
  const calls: Call[] = [];
  let failBootstrap = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ url, method, authorization: headers.get("Authorization"), body });
    if (headers.get("Authorization") !== "Bearer id-token") {
      return Response.json({ message: "Unauthorized" }, { status: 401 });
    }
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/api/bootstrap") && method === "GET") {
      if (failBootstrap > 0) {
        failBootstrap -= 1;
        return Response.json({ error: "一時的に失敗しました" }, { status: 502 });
      }
      const requested = parsed.searchParams.getAll("exercise");
      const names = requested.length > 0 ? requested : ["スクワット"];
      const catalog = [
        { name: "スクワット", lastPickedAt: null },
        { name: "ベンチプレス", lastPickedAt: null },
      ];
      const known: Record<string, { previous: ExerciseLog | null; today: ExerciseLog | null }> = {
        スクワット: { previous: squatPrevious, today: null },
        ベンチプレス: { previous: benchPrevious, today: null },
      };
      const logs: Record<string, { previous: ExerciseLog | null; today: ExerciseLog | null }> = {};
      for (const name of names) logs[name] = known[name] ?? { previous: null, today: null };
      return Response.json({
        date: parsed.searchParams.get("date"),
        exercises: catalog,
        recent: [{ name: "スクワット", lastPickedAt: "2026-09-25T12:00:00.000Z" }],
        logs,
      });
    }
    if (parsed.pathname.endsWith("/api/logs") && method === "POST") {
      const input = JSON.parse(body ?? "{}") as Partial<ExerciseLog>;
      return Response.json(
        log({
          id: "saved-1",
          exercise: String(input.exercise),
          weightKg: Number(input.weightKg),
          reps: Number(input.reps),
          sets: Number(input.sets),
          difficulty: 4,
          date: String(input.date),
          title: "－",
          createdAt: "2026-10-02T09:00:00.000Z",
        }),
        { status: 201 },
      );
    }
    return Response.json({ error: `予期しない経路 ${method} ${parsed.pathname}` }, { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    failNextBootstrap(times = 1) {
      failBootstrap = times;
    },
  };
}

function client() {
  return createHttpWorkoutClient({
    apiBaseUrl: "https://api.example/dev/",
    getIdToken: async () => "id-token",
    now: new Date(2026, 9, 2),
  });
}

function paths(calls: Call[]): string[] {
  return calls.map((call) => {
    const url = new URL(call.url);
    return `${call.method} ${url.pathname}`;
  });
}

describe("http workout client", () => {
  it("bootstraps once for the session, then serves navigation from cache", async () => {
    const api = installApi();
    try {
      const workout = client();
      const [squatPreviousLog, squatToday, pressPrevious] = await Promise.all([
        workout.getPreviousLog("スクワット", date),
        workout.getLogOnDate("スクワット", date),
        workout.getPreviousLog("レッグプレス", date),
      ]);
      expect(squatPreviousLog).toMatchObject({ weightKg: 80, date: "2026-09-25" });
      expect(squatToday).toBeNull();
      expect(pressPrevious).toBeNull();

      const bootstraps = api.calls.filter((call) => call.url.includes("/api/bootstrap"));
      expect(bootstraps.length).toBeGreaterThan(0);
      expect(bootstraps.every((call) => call.authorization === "Bearer id-token")).toBe(true);
      expect(bootstraps.some((call) => call.url.includes("NOTION"))).toBe(false);
      const first = new URL(bootstraps[0].url);
      expect(first.searchParams.get("date")).toBe(date);
      expect(first.searchParams.getAll("exercise")).toEqual(["スクワット", "レッグプレス"]);
      expect(paths(api.calls).every((path) => path.startsWith("GET /dev/api/bootstrap"))).toBe(true);

      const afterBootstrap = api.calls.length;
      await workout.listExercises();
      await workout.listRecentExercises();
      await workout.getPreviousLog("ベンチプレス", date);
      await workout.getLogOnDate("ベンチプレス", date);
      await workout.getPreviousLog("スクワット", date);
      expect(api.calls.length).toBe(afterBootstrap);
      expect(await workout.getPreviousLog("ベンチプレス", date)).toMatchObject({ weightKg: 60 });
      expect((await workout.listRecentExercises()).map((exercise) => exercise.name)).toEqual(["スクワット"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("posts a save and refreshes the local cache without another read", async () => {
    const api = installApi();
    try {
      const workout = client();
      await workout.getPreviousLog("スクワット", date);
      const reads = api.calls.length;
      const created = await workout.createLog({
        exercise: "スクワット",
        weightKg: 82.5,
        reps: 8,
        sets: 3,
        difficulty: 4,
        date,
        title: "－",
      });
      expect(created).toMatchObject({ id: "saved-1", weightKg: 82.5 });
      expect(api.calls.slice(reads).map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
        "POST /dev/api/logs",
      ]);
      expect(api.calls[reads].authorization).toBe("Bearer id-token");
      expect(JSON.parse(api.calls[reads].body ?? "{}")).toMatchObject({ exercise: "スクワット", weightKg: 82.5 });

      expect(await workout.getLogOnDate("スクワット", date)).toMatchObject({ id: "saved-1", weightKg: 82.5 });
      expect(await workout.getPreviousLog("スクワット", date)).toMatchObject({ id: "squat-prev" });
      expect((await workout.listRecentExercises())[0]).toMatchObject({
        name: "スクワット",
        lastPickedAt: "2026-10-02T09:00:00.000Z",
      });
      expect(api.calls.length).toBe(reads + 1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps a new exercise local until save, with no extra fetch on picker navigation", async () => {
    const api = installApi();
    try {
      const workout = client();
      await workout.listExercises();
      const afterStart = api.calls.length;
      await workout.touchExercise("ショルダープレス", "2026-10-02T08:00:00.000Z");
      expect((await workout.listExercises()).map((exercise) => exercise.name)).toContain("ショルダープレス");
      expect(await workout.getPreviousLog("ショルダープレス", date)).toBeNull();
      expect(await workout.getLogOnDate("ショルダープレス", date)).toBeNull();
      expect((await workout.listRecentExercises())[0]?.name).toBe("ショルダープレス");
      expect(api.calls.length).toBe(afterStart);
      await expect(workout.touchExercise("  ", "2026-10-02T08:00:00.000Z")).rejects.toThrow(
        "種目名を入力してください",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("splits a bootstrap larger than the API name cap", async () => {
    const api = installApi();
    try {
      const workout = client();
      const names = Array.from({ length: 41 }, (_, index) => `種目${index}`);
      await Promise.all(names.map((name) => workout.getPreviousLog(name, date)));
      const bootstraps = api.calls.filter((call) => new URL(call.url).pathname.endsWith("/api/bootstrap"));
      const sizes = bootstraps.map((call) => new URL(call.url).searchParams.getAll("exercise").length);
      expect(sizes[0]).toBe(40);
      expect(sizes[1]).toBe(1);
      expect(sizes.every((size) => size <= 40)).toBe(true);
      const after = api.calls.length;
      await workout.getLogOnDate(names[40], date);
      expect(api.calls.length).toBe(after);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retries after a failed bootstrap and surfaces the API error", async () => {
    const api = installApi();
    try {
      const workout = client();
      api.failNextBootstrap();
      await expect(workout.getPreviousLog("スクワット", date)).rejects.toThrow("一時的に失敗しました");
      await expect(workout.getPreviousLog("スクワット", date)).resolves.toMatchObject({ id: "squat-prev" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
