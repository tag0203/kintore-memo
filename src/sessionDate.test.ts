import { describe, expect, it, vi } from "vitest";
import { createDayPlanSaver } from "./data/dayPlanSync";
import { tokyoCivilDate } from "./domain";
import {
  SESSION_DATE_STORAGE_KEY,
  isWritableSessionDate,
  menuFromDayPlan,
  readStoredSessionDate,
  recallMenu,
  resolveStoredSessionDate,
  sessionDateAfterLoad,
  sessionDateChoices,
  sessionDateLabel,
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

describe("sessionDateLabel", () => {
  const onOct11 = new Date("2026-10-11T03:00:00.000Z");

  it("stays 今日 on Tokyo today", () => {
    expect(sessionDateLabel("2026-10-02", midday)).toBe("今日");
    expect(sessionDateLabel("2026-10-03", justAfterTokyoMidnight)).toBe("今日");
  });

  it("names yesterday and tomorrow with the month and day", () => {
    expect(sessionDateLabel("2026-10-10", onOct11)).toBe("10/10（前日）");
    expect(sessionDateLabel("2026-10-12", onOct11)).toBe("10/12（翌日）");
    expect(sessionDateLabel("2026-10-02", justAfterTokyoMidnight)).toBe("10/2（前日）");
  });

  it("does not call an older stored date 今日", () => {
    expect(sessionDateLabel("2026-09-30", midday)).toBe("9/30");
  });
});

describe("stored session date", () => {
  it("keeps an in-range date across a reload", () => {
    const storage = memoryStorage();
    writeStoredSessionDate(storage, "2026-10-01");
    expect(readStoredSessionDate(storage)).toBe("2026-10-01");
    expect(resolveStoredSessionDate(readStoredSessionDate(storage), midday)).toBe("2026-10-01");
  });

  it("keeps a stored date that is outside the writable window", () => {
    expect(resolveStoredSessionDate("2026-09-30", midday)).toBe("2026-09-30");
    expect(resolveStoredSessionDate("2026-10-01", justAfterTokyoMidnight)).toBe("2026-10-01");
  });

  it("starts on Tokyo today when nothing is stored, including a broken value", () => {
    expect(resolveStoredSessionDate(null, justAfterTokyoMidnight)).toBe("2026-10-03");
    expect(resolveStoredSessionDate("", midday)).toBe("2026-10-02");
    expect(resolveStoredSessionDate("2026-10-02T00:00:00", midday)).toBe("2026-10-02");
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
      choice: "save",
      flush: async () => {
        order.push("flush");
        return true;
      },
      discard: () => order.push("discard"),
      persist: (date) => {
        order.push(`persist:${date}`);
        writeStoredSessionDate(storage, date);
      },
    });
    expect(result).toEqual({ date: "2026-10-01", switched: true });
    expect(order).toEqual(["flush", "persist:2026-10-01"]);
    expect(readStoredSessionDate(storage)).toBe("2026-10-01");
    expect(resolveStoredSessionDate(readStoredSessionDate(storage), midday)).toBe("2026-10-01");
  });

  it("does not flush when the date is unchanged", async () => {
    const flush = vi.fn(async () => true);
    const persist = vi.fn();
    const discard = vi.fn();
    const same = await switchSessionDate({
      currentDate: "2026-10-02",
      nextDate: "2026-10-02",
      choice: "save",
      flush,
      discard,
      persist,
    });
    expect(same).toEqual({ date: "2026-10-02", switched: false, reason: "unchanged" });
    expect(flush).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });

  it("stays on the current date when the pending save fails", async () => {
    const persist = vi.fn();
    const discard = vi.fn();
    const result = await switchSessionDate({
      currentDate: "2026-10-02",
      nextDate: "2026-10-01",
      choice: "save",
      flush: async () => false,
      discard,
      persist,
    });
    expect(result).toEqual({ date: "2026-10-02", switched: false, reason: "save_failed" });
    expect(persist).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });

  it("discards unsaved edits and switches without sending", async () => {
    const flush = vi.fn(async () => true);
    const discard = vi.fn();
    const storage = memoryStorage("2026-10-02");
    const result = await switchSessionDate({
      currentDate: "2026-10-02",
      nextDate: "2026-10-03",
      choice: "discard",
      flush,
      discard,
      persist: (date) => writeStoredSessionDate(storage, date),
    });
    expect(result).toEqual({ date: "2026-10-03", switched: true });
    expect(flush).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledOnce();
    expect(readStoredSessionDate(storage)).toBe("2026-10-03");
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
      choice: "save",
      flush: () => saver.flush(),
      discard: () => saver.dropPending(),
      persist,
    });
    expect(result).toEqual({ date: "2026-10-02", switched: false, reason: "save_failed" });
    expect(persist).not.toHaveBeenCalled();
    await expect(saver.flush()).resolves.toBe(true);
    expect(save).toHaveBeenLastCalledWith(pending);
  });
});

describe("sessionDateAfterLoad", () => {
  it("persists a date only after it loads", () => {
    expect(sessionDateAfterLoad({ requested: "2026-10-03", ok: true, previous: "2026-10-02" })).toEqual({
      date: "2026-10-03",
      persist: true,
    });
  });

  it("returns to the previous date when the new one fails to load", () => {
    expect(sessionDateAfterLoad({ requested: "2026-10-03", ok: false, previous: "2026-10-02" })).toEqual({
      date: "2026-10-02",
      persist: false,
    });
  });

  it("keeps the requested date when nothing has loaded yet", () => {
    expect(sessionDateAfterLoad({ requested: "2026-10-03", ok: false, previous: null })).toEqual({
      date: "2026-10-03",
      persist: false,
    });
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
