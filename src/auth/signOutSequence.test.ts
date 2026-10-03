import { describe, expect, it, vi } from "vitest";
import { runBeforeSignOut } from "./signOutSequence";

describe("runBeforeSignOut", () => {
  it("finishes pending work before the caller clears the session", async () => {
    const order: string[] = [];
    await runBeforeSignOut([
      async () => {
        order.push("flush");
      },
    ]);
    order.push("clear");
    expect(order).toEqual(["flush", "clear"]);
  });

  it("still returns when a flush fails", async () => {
    const clear = vi.fn();
    await runBeforeSignOut([
      async () => {
        throw new Error("メニューの保存先に接続できませんでした");
      },
    ]);
    clear();
    expect(clear).toHaveBeenCalledOnce();
  });

  it("waits for a flush that finishes inside the timeout", async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      const pending = runBeforeSignOut(
        [
          () =>
            new Promise<void>((resolve) => {
              setTimeout(() => {
                order.push("flush");
                resolve();
              }, 40);
            }),
        ],
        { timeoutMs: 3_000 },
      ).then(() => {
        order.push("clear");
      });
      await vi.advanceTimersByTimeAsync(40);
      await pending;
      expect(order).toEqual(["flush", "clear"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting when a flush never settles", async () => {
    vi.useFakeTimers();
    try {
      let cleared = false;
      const pending = runBeforeSignOut([() => new Promise<void>(() => {})], { timeoutMs: 3_000 }).then(() => {
        cleared = true;
      });
      await vi.advanceTimersByTimeAsync(2_999);
      expect(cleared).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(cleared).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});