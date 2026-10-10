import { describe, expect, it, vi } from "vitest";
import { createDayPlanSaver } from "./data/dayPlanSync";
import { tokyoCivilDate } from "./domain";
import {
  SESSION_DATE_OUT_OF_RANGE_NOTICE,
  SESSION_DATE_STORAGE_KEY,
  isWritableSessionDate,
  menuFromDayPlan,
  msUntilNextTokyoDate,
  readStoredSessionDate,
  realignSessionDate,
  recallMenu,
  resolveStoredSessionDate,
  sessionDateChoices,
  storeMenu,
  switchSessionDate,
  writeStoredSessionDate,
  type SessionDateStorage,
  type SessionMenu,
} from "./sessionDate";

/** 2026-10-02 12:00 JST。UTC では同じ暦日。 */
const midday = new Date("2026-10-02T03:00:00.000Z");
/** 2026-10-03 00:30 JST。UTC ではまだ 2026-10-02。 */
const justAfterTokyoMidnight = new Date("2026-10-02T15:30:00.000Z");

function memoryStorage(initial: string | null = null): SessionDateStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  if (initial != null) values.set(SESSION_DATE_STORAGE_KEY, initial);
  return {
    values,
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

describe("tokyo session dates", () => {
  it("uses Asia/Tokyo around midnight, not the UTC calendar day", () => {
    expect(tokyoCivilDate(new Date("2026-10-02T14:59:00.000Z"))).toBe("2026-10-02");
    expect(tokyoCivilDate(justAfterTokyoMidnight)).toBe("2026-10-03");
    expect(tokyoCivilDate(new Date("2026-10-02T15:00:00.000Z"))).toBe("2026-10-03");
  });

  it("offers only Tokyo yesterday, today, and tomorrow", () => {
    expect(sessionDateChoices(midday)).toEqual([
      { date: "2026-10-01", label: "前日" },
      { date: "2026-10-02", label: "今日" },
      { date: "2026-10-03", label: "翌日" },
    ]);
    expect(isWritableSessionDate("2026-10-01", midday)).toBe(true);
    expect(isWritableSessionDate("2026-10-04", midday)).toBe(false);
    expect(isWritableSessionDate("2026-09-30", midday)).toBe(false);
    expect(sessionDateChoices(justAfterTokyoMidnight).map((choice) => choice.date)).toEqual([
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ]);
  });
});

describe("stored session date", () => {
  it("keeps an in-range date across a reload", () => {
    const storage = memoryStorage();
    writeStoredSessionDate(storage, "2026-10-01");
    expect(readStoredSessionDate(storage)).toBe("2026-10-01");
    expect(resolveStoredSessionDate(readStoredSessionDate(storage), midday)).toEqual({
      date: "2026-10-01",
      notice: null,
    });
  });

  it("keeps yesterday after Tokyo midnight while it is still inside the window", () => {
    const storage = memoryStorage("2026-10-02");
    expect(resolveStoredSessionDate(readStoredSessionDate(storage), justAfterTokyoMidnight)).toEqual({
      date: "2026-10-02",
      notice: null,
    });
  });

  it("falls back to Tokyo today when the stored date is outside the window", () => {
    const storage = memoryStorage("2026-09-30");
    const resolved = resolveStoredSessionDate(readStoredSessionDate(storage), midday);
    expect(resolved).toEqual({ date: "2026-10-02", notice: SESSION_DATE_OUT_OF_RANGE_NOTICE });
    expect(resolved.notice).toContain("今日");

    const afterMidnight = resolveStoredSessionDate(readStoredSessionDate(memoryStorage("2026-10-01")), justAfterTokyoMidnight);
    expect(afterMidnight.date).toBe("2026-10-03");
    expect(afterMidnight.notice).toBe(SESSION_DATE_OUT_OF_RANGE_NOTICE);
  });

  it("starts on Tokyo today when nothing is stored, including a broken value", () => {
    expect(resolveStoredSessionDate(null, justAfterTokyoMidnight)).toEqual({
      date: "2026-10-03",
      notice: null,
    });
    expect(resolveStoredSessionDate("", midday).notice).toBeNull();
    expect(resolveStoredSessionDate("2026-10-02T00:00:00", midday)).toEqual({
      date: "2026-10-02",
      notice: SESSION_DATE_OUT_OF_RANGE_NOTICE,
    });
  });

  it("ignores a storage read that throws", () => {
    const storage: SessionDateStorage = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
    };
    expect(readStoredSessionDate(storage)).toBeNull();
    expect(() => writeStoredSessionDate(storage, "2026-10-02")).not.toThrow();
  });
});

describe("switchSessionDate", () => {
  it("flushes the pending save before persisting the new date", async () => {
    const order: string[] = [];
    const storage = memoryStorage("2026-10-02");
    const result = await switchSessionDate({
      currentDate: "2026-10-02",
      nextDate: "2026-10-01",
      now: midday,
      flush: async () => {
        order.push("flush");
        return true;
      },
      persist: (date) => {
        order.push(`persist:${date}`);
        writeStoredSessionDate(storage, date);
      },
    });
    expect(result).toEqual({ date: "2026-10-01", switched: true });
    expect(order).toEqual(["flush", "persist:2026-10-01"]);
    expect(readStoredSessionDate(storage)).toBe("2026-10-01");
    expect(resolveStoredSessionDate(readStoredSessionDate(storage), midday).date).toBe("2026-10-01");
  });

  it("does not flush when the date is unchanged or outside the window", async () => {
    const flush = vi.fn(async () => true);
    const persist = vi.fn();
    const same = await switchSessionDate({
      currentDate: "2026-10-02",
      nextDate: "2026-10-02",
      now: midday,
      flush,
      persist,
    });
    const far = await switchSessionDate({
      currentDate: "2026-10-02",
      nextDate: "2026-09-30",
      now: midday,
      flush,
      persist,
    });
    expect(same).toEqual({ date: "2026-10-02", switched: false, reason: "unchanged" });
    expect(far).toEqual({ date: "2026-10-02", switched: false, reason: "out_of_window" });
    expect(flush).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("stays on the current date when the pending save fails", async () => {
    const persist = vi.fn();
    const result = await switchSessionDate({
      currentDate: "2026-10-02",
      nextDate: "2026-10-01",
      now: midday,
      flush: async () => false,
      persist,
    });
    expect(result).toEqual({ date: "2026-10-02", switched: false, reason: "save_failed" });
    expect(persist).not.toHaveBeenCalled();
  });

  it("keeps the unsaved DayPlan when the flush fails, so a later save can still write it", async () => {
    const save = vi.fn(async () => {});
    save.mockImplementationOnce(async () => {
      throw new Error("メニューの保存先に接続できませんでした");
    });
    const saver = createDayPlanSaver(save, { waitMs: 10_000 });
    const pending = {
      date: "2026-10-02",
      memo: "脚",
      exercises: ["スクワット"],
      finished: false,
    };
    saver.markSaved({ ...pending, memo: "" });
    saver.schedule(pending);
    const persist = vi.fn();
    const result = await switchSessionDate({
      currentDate: "2026-10-02",
      nextDate: "2026-10-01",
      now: midday,
      flush: () => saver.flush(),
      persist,
    });
    expect(result).toEqual({ date: "2026-10-02", switched: false, reason: "save_failed" });
    expect(persist).not.toHaveBeenCalled();
    await expect(saver.flush()).resolves.toBe(true);
    expect(save).toHaveBeenLastCalledWith(pending);
  });
});

describe("realignSessionDate", () => {
  it("leaves a date that is still inside the Tokyo window", async () => {
    const flush = vi.fn(async () => true);
    const persist = vi.fn();
    const result = await realignSessionDate({
      selected: "2026-10-02",
      now: justAfterTokyoMidnight,
      flush,
      persist,
    });
    expect(result).toEqual({ date: "2026-10-02", notice: null, changed: false });
    expect(flush).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(msUntilNextTokyoDate(new Date("2026-10-02T14:59:00.000Z"))).toBe(60_000);
    expect(msUntilNextTokyoDate(justAfterTokyoMidnight)).toBe(23.5 * 60 * 60 * 1000);
  });

  it("saves, then falls back to Tokyo today when the selected date leaves the window", async () => {
    const order: string[] = [];
    const storage = memoryStorage("2026-10-01");
    const result = await realignSessionDate({
      selected: "2026-10-01",
      now: justAfterTokyoMidnight,
      flush: async () => {
        order.push("flush");
        return true;
      },
      persist: (date) => {
        order.push(`persist:${date}`);
        writeStoredSessionDate(storage, date);
      },
    });
    expect(result).toEqual({
      date: "2026-10-03",
      notice: SESSION_DATE_OUT_OF_RANGE_NOTICE,
      changed: true,
    });
    expect(order).toEqual(["flush", "persist:2026-10-03"]);
    expect(readStoredSessionDate(storage)).toBe("2026-10-03");
  });

  it("does not change the date when the save before the fallback fails", async () => {
    const persist = vi.fn();
    const result = await realignSessionDate({
      selected: "2026-10-01",
      now: justAfterTokyoMidnight,
      flush: async () => false,
      persist,
    });
    expect(result).toEqual({ date: "2026-10-01", notice: null, changed: false });
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("menu per date", () => {
  it("keeps finished on the date it was stored with", () => {
    const menus = new Map<string, SessionMenu>();
    storeMenu(menus, "2026-10-02", { memo: "脚", exercises: ["スクワット"], finished: true });
    storeMenu(menus, "2026-10-03", { memo: "", exercises: ["ベンチプレス"], finished: false });
    expect(recallMenu(menus, "2026-10-02")).toEqual({
      memo: "脚",
      exercises: ["スクワット"],
      finished: true,
    });
    expect(recallMenu(menus, "2026-10-03").finished).toBe(false);
    expect(recallMenu(menus, "2026-10-01")).toEqual({ memo: "", exercises: [], finished: false });
  });

  it("copies finished from the DayPlan loaded for that date", () => {
    const finished = menuFromDayPlan({ memo: "脚", exercises: ["スクワット"], finished: true });
    const open = menuFromDayPlan({ memo: "", exercises: ["ベンチプレス"], finished: false });
    expect(finished).toEqual({ memo: "脚", exercises: ["スクワット"], finished: true });
    expect(open.finished).toBe(false);
    finished.exercises.push("レッグプレス");
    expect(menuFromDayPlan({ memo: "脚", exercises: ["スクワット"], finished: true }).exercises).toEqual([
      "スクワット",
    ]);
  });
});
