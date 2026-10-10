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

  it("hides upstream text on a storage failure and shows requestId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: "arn:aws:dynamodb:ap-northeast-1:123456789012:table/App",
              message: "https://example.invalid/a1b2c3d4-e5f6-4789-a123-ef1234567890",
              requestId: "req-day-1",
            }),
            { status: 502 },
          ),
      ),
    );
    try {
      await client().load("2026-10-02");
      expect.fail("expected an error");
    } catch (error) {
      expect(error).toBeInstanceOf(DayPlanRequestError);
      const fault = error as DayPlanRequestError;
      expect(fault.message).toBe("メニューの保存先に接続できませんでした（req-day-1）");
      expect(fault.code).toBe("storage");
      expect(fault.message).not.toContain("arn:");
      expect(fault.message).not.toContain("123456789012");
      expect(fault.message).not.toContain("example.invalid");
      expect(fault.code).not.toContain("arn:");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not append an ARN or account id supplied as requestId", async () => {
    for (const requestId of ["arn:aws:iam::123456789012:root", "123456789012"]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({ error: "storage", message: "raw", requestId }),
              { status: 502 },
            ),
        ),
      );
      try {
        await client().load("2026-10-02");
        expect.fail("expected an error");
      } catch (error) {
        expect(error).toBeInstanceOf(DayPlanRequestError);
        const fault = error as DayPlanRequestError;
        expect(fault.message).toBe("メニューの保存先に接続できませんでした");
        expect(fault.message).not.toContain("arn:");
        expect(fault.message).not.toContain("123456789012");
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });
});
