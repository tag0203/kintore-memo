import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DayPlanLoadFailure } from "./session";

describe("DayPlanLoadFailure", () => {
  it("keeps logout on the retry screen", () => {
    const html = renderToStaticMarkup(
      createElement(DayPlanLoadFailure, {
        message: "メニューを読み込めませんでした",
        onRetry: vi.fn(),
        onSignOut: vi.fn(),
      }),
    );
    expect(html).toContain("ログアウト");
    expect(html).toContain("再読み込み");
    expect(html).toContain("メニューを読み込めませんでした");
  });

  it("omits logout when sign-in is not configured", () => {
    const html = renderToStaticMarkup(
      createElement(DayPlanLoadFailure, {
        message: "メニューを読み込めませんでした",
        onRetry: vi.fn(),
        onSignOut: null,
      }),
    );
    expect(html).not.toContain("ログアウト");
    expect(html).toContain("再読み込み");
  });
});
