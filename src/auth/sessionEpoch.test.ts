import { describe, expect, it } from "vitest";
import { mayApplyRefreshedTokens } from "./sessionEpoch";

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
