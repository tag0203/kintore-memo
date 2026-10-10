import { afterEach, describe, expect, it, vi } from "vitest";
import { DayPlanRequestError, type DayPlanInput } from "./dayPlanClient";
import { DAY_PLAN_SAVE_ERROR, createDayPlanSaver } from "./dayPlanSync";

function plan(memo: string, extras: Partial<DayPlanInput> = {}): DayPlanInput {
  return {
    date: "2026-10-02",
    memo,
    exercises: ["スクワット"],
    finished: false,
    ...extras,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createDayPlanSaver", () => {
  it("does not write a snapshot that was just loaded", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => {});
    const saver = createDayPlanSaver(save, { waitMs: 400 });
    saver.markSaved(plan("脚"));
    saver.schedule(plan("脚"));
    await vi.advanceTimersByTimeAsync(400);
    expect(save).not.toHaveBeenCalled();
  });

  it("debounces edits and then saves the latest menu", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => {});
    const saver = createDayPlanSaver(save, { waitMs: 400 });
    saver.markSaved(plan(""));
    saver.schedule(plan("脚"));
    saver.schedule(plan("胸", { exercises: ["ベンチプレス"], finished: true }));
    await vi.advanceTimersByTimeAsync(399);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(plan("胸", { exercises: ["ベンチプレス"], finished: true }));
  });

  it("finishes an in-flight save and then writes the newer snapshot", async () => {
    const calls: string[] = [];
    let release: () => void = () => {
      throw new Error("save did not start");
    };
    const save = vi.fn(async (input: DayPlanInput) => {
      calls.push(input.memo);
      if (calls.length === 1) {
        await new Promise<void>((resolve) => {
          release = () => resolve();
        });
      }
    });
    const saver = createDayPlanSaver(save, { waitMs: 10_000 });
    saver.schedule(plan("a"));
    const first = saver.flush();
    await Promise.resolve();
    saver.schedule(plan("b"));
    const second = saver.flush();
    release();
    await first;
    await second;
    expect(calls).toEqual(["a", "b"]);
  });

  it("drops an unsent edit when a newer one is flushed first", async () => {
    const save = vi.fn(async () => {});
    const saver = createDayPlanSaver(save, { waitMs: 10_000 });
    saver.schedule(plan("a"));
    saver.schedule(plan("b"));
    await saver.flush();
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(plan("b"));
  });

  it("does not let a saver from an older session replace a newer plan", async () => {
    let epoch = 1;
    const save = vi.fn(async () => {});
    const stale = createDayPlanSaver(save, { allowWrite: () => epoch === 0 });
    const current = createDayPlanSaver(save, { allowWrite: () => epoch === 1 });
    stale.schedule(plan("脚"));
    current.schedule(plan("胸"));
    await stale.flush();
    await current.flush();
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(plan("胸"));
  });

  it("cancel drops a pending debounce without blocking a later edit", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => {});
    const saver = createDayPlanSaver(save, { waitMs: 400 });
    saver.schedule(plan("脚"));
    saver.cancel();
    await vi.advanceTimersByTimeAsync(400);
    expect(save).not.toHaveBeenCalled();
    saver.schedule(plan("胸"));
    await vi.advanceTimersByTimeAsync(400);
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(plan("胸"));
  });

  it("reports a failed save and clears it after the next success", async () => {
    const errors: string[] = [];
    let saved = 0;
    let fail = true;
    const save = vi.fn(async () => {
      if (fail) throw new Error("メニューの保存先に接続できませんでした");
    });
    const saver = createDayPlanSaver(save, { waitMs: 10_000 });
    saver.setListeners({
      onError: (message) => errors.push(message),
      onSaved: () => {
        saved += 1;
      },
    });
    saver.schedule(plan("脚"));
    await expect(saver.flush()).resolves.toBe(false);
    expect(errors).toEqual([DAY_PLAN_SAVE_ERROR]);
    expect(save).toHaveBeenCalledWith(plan("脚"));
    fail = false;
    saver.schedule(plan("胸"));
    await expect(saver.flush()).resolves.toBe(true);
    expect(saved).toBe(1);
  });

  it("keeps a failed snapshot so a later flush can still save it", async () => {
    const save = vi.fn(async () => {});
    save.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    const saver = createDayPlanSaver(save, { waitMs: 10_000 });
    saver.markSaved(plan(""));
    saver.schedule(plan("脚"));
    await expect(saver.flush()).resolves.toBe(false);
    await expect(saver.flush()).resolves.toBe(true);
    expect(save).toHaveBeenLastCalledWith(plan("脚"));
    expect(saver.dirty()).toBe(false);
  });

  it("drops an unsaved snapshot without sending it again", async () => {
    const save = vi.fn(async () => {
      throw new DayPlanRequestError("その日付のメニューは保存できません", 400, "date_window");
    });
    const errors: string[] = [];
    const saver = createDayPlanSaver(save, { waitMs: 10_000 });
    saver.setListeners({ onError: (message) => errors.push(message) });
    saver.markSaved(plan(""));
    saver.schedule(plan("脚", { date: "2026-10-01" }));
    expect(saver.dirty()).toBe(true);
    await expect(saver.flush()).resolves.toBe(false);
    expect(errors).toEqual([DAY_PLAN_SAVE_ERROR]);
    saver.dropPending();
    expect(saver.dirty()).toBe(false);
    await expect(saver.flush()).resolves.toBe(true);
    expect(save).toHaveBeenCalledOnce();
  });
});
