import { afterEach, describe, expect, it, vi } from "vitest";
import type { DayPlanInput } from "./dayPlanClient";
import { createDayPlanSaver } from "./dayPlanSync";

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
    await saver.flush();
    expect(errors).toEqual(["メニューの保存先に接続できませんでした"]);
    fail = false;
    saver.schedule(plan("胸"));
    await saver.flush();
    expect(saved).toBe(1);
  });
});
