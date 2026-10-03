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
});