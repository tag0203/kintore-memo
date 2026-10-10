import { describe, expect, it, vi } from "vitest";
import { createDayPlanSaver } from "./data/dayPlanSync";
import { tokyoCivilDate } from "./domain";
import {
  SESSION_DATE_NOT_SELECTABLE,
  SESSION_DATE_OUT_OF_RANGE_NOTICE,
  SESSION_DATE_STORAGE_KEY,
  SESSION_DATE_UNSAVEABLE_NOTICE,
  createDateChangeHold,
  isWritableSessionDate,
  menuFromDayPlan,
  msUntilNextTokyoDate,
  outOfWindowSelectionNotice,
  readStoredSessionDate,
  realignSessionDate,
  recallMenu,
  resolveStoredSessionDate,
  sessionDateAfterUnsaveable,
  sessionDateChoices,
  sessionDateChoicesFromToday,
  storeMenu,
  switchSessionDate,
  tokyoTodayAdvance,
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

  it("does not persist when the current date can never be saved", async () => {
    const persist = vi.fn();
    const result = await switchSessionDate({
      currentDate: "2026-10-01",
      nextDate: "2026-10-03",
      now: justAfterTokyoMidnight,
      flush: async () => ({ ok: false, unsaveable: true }),
      persist,
    });
    expect(result).toEqual({ date: "2026-10-01", switched: false, reason: "unsaveable" });
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

describe("tokyo today for the date picker", () => {
  it("moves the three choices when Tokyo's civil date advances, even if the selected date stays writable", () => {
    const before = tokyoTodayAdvance("2026-10-02", midday);
    expect(before).toEqual({
      today: "2026-10-02",
      advanced: false,
      choices: sessionDateChoices(midday),
    });

    const after = tokyoTodayAdvance("2026-10-02", justAfterTokyoMidnight);
    expect(after.advanced).toBe(true);
    expect(after.today).toBe("2026-10-03");
    expect(after.choices).toEqual([
      { date: "2026-10-02", label: "前日" },
      { date: "2026-10-03", label: "今日" },
      { date: "2026-10-04", label: "翌日" },
    ]);
    expect(sessionDateChoicesFromToday(after.today)).toEqual(after.choices);
    expect(isWritableSessionDate("2026-10-02", justAfterTokyoMidnight)).toBe(true);
    expect(isWritableSessionDate("2026-10-01", justAfterTokyoMidnight)).toBe(false);
    expect(isWritableSessionDate("2026-10-04", justAfterTokyoMidnight)).toBe(true);
  });

  it("reports an out-of-window pick instead of treating it as unchanged", async () => {
    expect(outOfWindowSelectionNotice("2026-10-01", justAfterTokyoMidnight)).toBe(SESSION_DATE_NOT_SELECTABLE);
    expect(outOfWindowSelectionNotice("2026-10-02", justAfterTokyoMidnight)).toBeNull();
    expect(outOfWindowSelectionNotice("2026-10-04", justAfterTokyoMidnight)).toBeNull();

    const flush = vi.fn(async () => true);
    const persist = vi.fn();
    const stale = await switchSessionDate({
      currentDate: "2026-10-02",
      nextDate: "2026-10-01",
      now: justAfterTokyoMidnight,
      flush,
      persist,
    });
    expect(stale).toEqual({ date: "2026-10-02", switched: false, reason: "out_of_window" });
    expect(flush).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();

    const tomorrow = await switchSessionDate({
      currentDate: "2026-10-02",
      nextDate: "2026-10-04",
      now: justAfterTokyoMidnight,
      flush: async () => true,
      persist,
    });
    expect(tomorrow).toEqual({ date: "2026-10-04", switched: true });
    expect(persist).toHaveBeenCalledWith("2026-10-04");
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
    expect(result).toEqual({ date: "2026-10-02", notice: null, changed: false, dropped: false });
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
      dropped: false,
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
    expect(result).toEqual({ date: "2026-10-01", notice: null, changed: false, dropped: false });
    expect(persist).not.toHaveBeenCalled();
  });

  it("moves to today without retrying when the old date can never be saved", async () => {
    const persist = vi.fn();
    const result = await realignSessionDate({
      selected: "2026-10-01",
      now: justAfterTokyoMidnight,
      flush: async () => ({ ok: false, unsaveable: true }),
      persist,
    });
    expect(result).toEqual({
      date: "2026-10-03",
      notice: SESSION_DATE_UNSAVEABLE_NOTICE,
      changed: true,
      dropped: true,
    });
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("2026-10-03");
    expect(sessionDateAfterUnsaveable("2026-10-04", justAfterTokyoMidnight)).toBe("2026-10-04");
    expect(sessionDateAfterUnsaveable("2026-10-01", justAfterTokyoMidnight)).toBe("2026-10-03");
  });
});

describe("automatic date change hold", () => {
  it("stays held until every draft is released, and a second release is a no-op", () => {
    const hold = createDateChangeHold();
    expect(hold.held()).toBe(false);
    const release = hold.hold();
    const second = hold.hold();
    expect(hold.held()).toBe(true);
    release();
    expect(hold.held()).toBe(true);
    release();
    expect(hold.held()).toBe(true);
    second();
    expect(hold.held()).toBe(false);
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
