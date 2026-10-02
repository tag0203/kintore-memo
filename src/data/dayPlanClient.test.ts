import { describe, expect, it, vi } from "vitest";
import { DayPlanRequestError, createHttpDayPlanClient } from "./dayPlanClient";

const BASE = "https://api.example/dev";

function client() {
  return createHttpDayPlanClient({
    apiBaseUrl: `${BASE}/`,
    getIdToken: async () => "id-token",
  });
}

describe("createHttpDayPlanClient", () => {
  it("loads a day plan with the IdToken and an encoded date", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${BASE}/api/day-plan?date=2026-10-02`);
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer id-token");
      return new Response(
        JSON.stringify({
          date: "2026-10-02",
          memo: "",
          exercises: [],
          finished: false,
          updatedAt: null,
          userId: "ignored",
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const plan = await client().load("2026-10-02");
      expect(plan).toEqual({
        date: "2026-10-02",
        memo: "",
        exercises: [],
        finished: false,
        updatedAt: null,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("puts memo, menu, and finished without workout fields", async () => {
    let body = "";
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      expect(init?.keepalive).toBe(true);
      body = String(init?.body);
      return new Response(
        JSON.stringify({
          date: "2026-10-02",
          memo: "胸",
          exercises: ["ベンチプレス"],
          finished: true,
          updatedAt: "2026-10-02T03:00:00.000Z",
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const saved = await client().save({
        date: "2026-10-02",
        memo: "胸",
        exercises: ["ベンチプレス"],
        finished: true,
      });
      expect(JSON.parse(body)).toEqual({
        date: "2026-10-02",
        memo: "胸",
        exercises: ["ベンチプレス"],
        finished: true,
      });
      expect(saved.finished).toBe(true);
      expect(saved.updatedAt).toBe("2026-10-02T03:00:00.000Z");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("maps an out-of-window date to a Japanese message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "date_window", message: "date is outside" }), { status: 400 })),
    );
    try {
      await client().save({ date: "2020-01-01", memo: "", exercises: [], finished: false });
      expect.fail("expected an error");
    } catch (error) {
      expect(error).toBeInstanceOf(DayPlanRequestError);
      expect((error as DayPlanRequestError).code).toBe("date_window");
      expect((error as DayPlanRequestError).message).toBe("その日付のメニューは保存できません");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
