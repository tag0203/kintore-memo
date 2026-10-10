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

const squatPreviousLight = log({
  id: "squat-prev-light",
  exercise: "スクワット",
  weightKg: 60,
  date: "2026-09-25",
  createdAt: "2026-09-25T11:00:00.000Z",
});

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
  let saved = 0;
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
        return Response.json(
          { error: "Notion との通信に失敗しました", requestId: "ZoG1fH0oIAMEjeg=" },
          { status: 502 },
        );
      }
      const requested = parsed.searchParams.getAll("exercise");
      const names = requested.length > 0 ? requested : ["スクワット"];
      const catalog = [
        { name: "スクワット", lastPickedAt: null },
        { name: "ベンチプレス", lastPickedAt: null },
      ];
      const known: Record<string, { previous: ExerciseLog[]; today: ExerciseLog[] }> = {
        スクワット: { previous: [squatPreviousLight, squatPrevious], today: [] },
        ベンチプレス: { previous: [benchPrevious], today: [] },
      };
      const logs: Record<string, { previous: ExerciseLog[]; today: ExerciseLog[] }> = {};
      for (const name of names) logs[name] = known[name] ?? { previous: [], today: [] };
      return Response.json({
        date: parsed.searchParams.get("date"),
        exercises: catalog,
        recent: [{ name: "スクワット", lastPickedAt: "2026-09-25T12:00:00.000Z" }],
        logs,
      });
    }
    if (parsed.pathname.endsWith("/api/logs") && method === "POST") {
      const input = JSON.parse(body ?? "{}") as Partial<ExerciseLog>;
      saved += 1;
      return Response.json(
        log({
          id: `saved-${saved}`,
          exercise: String(input.exercise),
          weightKg: Number(input.weightKg),
          reps: Number(input.reps),
          sets: Number(input.sets),
          difficulty: 4,
          date: String(input.date),
          title: "－",
          createdAt: `2026-10-02T09:00:0${saved}.000Z`,
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
      expect(squatPreviousLog).toMatchObject([
        { id: "squat-prev-light", weightKg: 60, date: "2026-09-25" },
        { id: "squat-prev", weightKg: 80, date: "2026-09-25" },
      ]);
      expect(squatToday).toEqual([]);
      expect(pressPrevious).toEqual([]);

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
      expect(await workout.getPreviousLog("ベンチプレス", date)).toMatchObject([{ weightKg: 60 }]);
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

      expect(await workout.getLogOnDate("スクワット", date)).toMatchObject([{ id: "saved-1", weightKg: 82.5 }]);
      expect(await workout.getPreviousLog("スクワット", date)).toMatchObject([
        { id: "squat-prev-light", weightKg: 60 },
        { id: "squat-prev", weightKg: 80 },
      ]);
      const second = await workout.createLog({
        exercise: "スクワット",
        weightKg: 90,
        reps: 6,
        sets: 3,
        difficulty: 5,
        date,
        title: "－",
      });
      expect(second.id).toBe("saved-2");
      expect(await workout.getLogOnDate("スクワット", date)).toMatchObject([
        { id: "saved-1", weightKg: 82.5 },
        { id: "saved-2", weightKg: 90 },
      ]);
      expect(await workout.getPreviousLog("スクワット", date)).toMatchObject([
        { id: "squat-prev-light" },
        { id: "squat-prev" },
      ]);
      expect((await workout.listRecentExercises())[0]).toMatchObject({
        name: "スクワット",
        lastPickedAt: "2026-10-02T09:00:02.000Z",
      });
      expect(api.calls.length).toBe(reads + 2);
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
      expect(await workout.getPreviousLog("ショルダープレス", date)).toEqual([]);
      expect(await workout.getLogOnDate("ショルダープレス", date)).toEqual([]);
      expect((await workout.listRecentExercises())[0]?.name).toBe("ショルダープレス");
      expect(api.calls.length).toBe(afterStart);
      await expect(workout.touchExercise("  ", "2026-10-02T08:00:00.000Z")).rejects.toThrow(
        "種目名を入力してください",
      );
      await expect(workout.touchExercise("スクワット#脚", "2026-10-02T08:00:00.000Z")).rejects.toThrow(
        "種目名を確認してください",
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
      await expect(workout.getPreviousLog("スクワット", date)).rejects.toThrow(
        "Notion との通信に失敗しました（ZoG1fH0oIAMEjeg=）",
      );
      await expect(workout.getPreviousLog("スクワット", date)).resolves.toMatchObject([
        { id: "squat-prev-light" },
        { id: "squat-prev" },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows a fixed message for 5xx and keeps the 400 validation text", async () => {
    const leak =
      "User: arn:aws:sts::123456789012:assumed-role/example/fn https://example.invalid/v1/databases/a1b2c3d4-e5f6-4789-a123-ef1234567890";
    let mode: "leak" | "validation" = "leak";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (mode === "validation") {
          return Response.json({ error: "date は YYYY-MM-DD で指定してください" }, { status: 400 });
        }
        return Response.json(
          { error: leak, message: leak, requestId: "https://example.invalid/req" },
          { status: 502 },
        );
      }),
    );
    try {
      const workout = client();
      await expect(workout.listExercises()).rejects.toThrow("記録の取得に失敗しました");
      await expect(workout.listExercises()).rejects.not.toThrow(/arn:|123456789012|example\.invalid|a1b2c3d4/);

      mode = "validation";
      const again = client();
      await expect(again.listExercises()).rejects.toThrow("date は YYYY-MM-DD で指定してください");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not append an ARN, account id, token, or Notion id supplied as requestId", async () => {
    for (const requestId of [
      "arn:aws:iam::123456789012:root",
      "123456789012",
      "ntn_" + "secretvalue",
      "secret_" + "ABC123456",
      "a1b2c3d4e5f64789a123ef1234567890",
      "a1b2c3d4-e5f6-4789-a123-ef1234567890",
      "11111111-2222-4333-8444-555555555555",
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({ error: "サーバーでエラーが発生しました", requestId }, { status: 500 }),
        ),
      );
      try {
        await client().listExercises();
        expect.fail("expected an error");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("サーバーでエラーが発生しました");
        expect((error as Error).message).not.toContain("arn:");
        expect((error as Error).message).not.toContain("123456789012");
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });

  it("appends a safe requestId to the fixed 5xx message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: "サーバーでエラーが発生しました", requestId: "ZoG1fH0oIAMEjeg=" },
          { status: 500 },
        ),
      ),
    );
    try {
      const workout = client();
      await expect(workout.listExercises()).rejects.toThrow(
        "サーバーでエラーが発生しました（ZoG1fH0oIAMEjeg=）",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
