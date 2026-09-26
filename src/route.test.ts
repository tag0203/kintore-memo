import { describe, expect, it } from "vitest";
import { parseHash, routeToHash } from "./route";

describe("hash routes", () => {
  it("round-trips the three screens", () => {
    expect(parseHash(routeToHash({ screen: "today" }))).toEqual({ screen: "today" });
    expect(parseHash(routeToHash({ screen: "picker" }))).toEqual({ screen: "picker" });
    expect(parseHash(routeToHash({ screen: "record", exercise: "レッグプレス" }))).toEqual({
      screen: "record",
      exercise: "レッグプレス",
    });
  });
});
