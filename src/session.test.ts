import { describe, expect, it } from "vitest";
import { INITIAL_MEMO, INITIAL_PLAN } from "./data/seed";
import { initialMenu } from "./session";

describe("initialMenu", () => {
  it("keeps the mock seed when DayPlan is not configured", () => {
    expect(initialMenu(false)).toEqual({ memo: INITIAL_MEMO, exercises: [...INITIAL_PLAN] });
  });

  it("starts empty when the API will restore a DayPlan", () => {
    expect(initialMenu(true)).toEqual({ memo: "", exercises: [] });
  });
});
