import { describe, expect, it } from "vitest";
import { idTokenAfterRefresh, mayApplyRefreshedTokens } from "./sessionEpoch";

describe("mayApplyRefreshedTokens", () => {
  it("keeps a refresh that finished before logout", () => {
    const started = 0;
    expect(mayApplyRefreshedTokens(started, started)).toBe(true);
  });

  it("ignores a refresh that resolves after logout cleared the session", () => {
    const started = 0;
    const afterClear = started + 1;
    expect(mayApplyRefreshedTokens(started, afterClear)).toBe(false);
  });

  it("still accepts a refresh started on the session after that logout", () => {
    const afterClear = 1;
    expect(mayApplyRefreshedTokens(afterClear, afterClear)).toBe(true);
  });
});

describe("idTokenAfterRefresh", () => {
  it("returns a token that finished before logout", () => {
    expect(idTokenAfterRefresh(0, 0, "fresh-id")).toBe("fresh-id");
  });

  it("does not hand back a token that arrives after logout", () => {
    expect(() => idTokenAfterRefresh(0, 1, "stale-id")).toThrow("ログアウトしました");
  });
});
