import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ExerciseLog } from "../domain";
import { TodayExerciseRow, removalConfirmBody } from "./TodayScreen";

function log(id: string): ExerciseLog {
  return {
    id,
    exercise: "レッグカール",
    weightKg: 40,
    reps: 12,
    sets: 3,
    difficulty: 2,
    date: "2026-10-10",
    title: "－",
    createdAt: "2026-10-10T08:10:00.000Z",
  };
}

describe("TodayExerciseRow", () => {
  it("places 外す outside the card so the card stays the record target", () => {
    const html = renderToStaticMarkup(
      createElement(TodayExerciseRow, {
        index: 0,
        name: "スクワット",
        previous: [],
        today: [],
        removable: true,
        onOpen: vi.fn(),
        onRemove: vi.fn(),
      }),
    );
    const card = html.slice(0, html.indexOf("</button>") + "</button>".length);
    expect(card).toContain("exercise-card");
    expect(card).toContain("スクワット");
    expect(card).toContain("未");
    expect(card).not.toContain("外す");
    expect(html).toContain("スクワットを今日のメニューから外す");
  });

  it("hides 外す when the menu is not being edited", () => {
    const html = renderToStaticMarkup(
      createElement(TodayExerciseRow, {
        index: 1,
        name: "レッグカール",
        previous: [],
        today: [log("a"), log("b")],
        removable: false,
        onOpen: vi.fn(),
        onRemove: vi.fn(),
      }),
    );
    expect(html).not.toContain("外す");
    expect(html).toContain("2件");
  });
});

describe("removalConfirmBody", () => {
  it("states that Notion records are kept", () => {
    const body = removalConfirmBody(2);
    expect(body).toContain("2件");
    expect(body).toContain("Notion");
    expect(body).toContain("削除されません");
  });
});
