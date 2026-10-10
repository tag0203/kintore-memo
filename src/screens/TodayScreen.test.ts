import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ExerciseLog } from "../domain";
import { SESSION_DATE_OUT_OF_RANGE_NOTICE } from "../sessionDate";
import { SessionDatePicker, TodayExerciseRow, removalConfirmBody } from "./TodayScreen";

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

describe("SessionDatePicker", () => {
  const choices = [
    { date: "2026-10-01", label: "前日" as const },
    { date: "2026-10-02", label: "今日" as const },
    { date: "2026-10-03", label: "翌日" as const },
  ];

  it("shows yesterday, today, and tomorrow as separate choices", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDatePicker, {
        date: "2026-10-02",
        choices,
        open: true,
        notice: null,
        onToggle: vi.fn(),
        onSelect: vi.fn(),
        onDismissNotice: vi.fn(),
      }),
    );
    expect(html).toContain("2026/10/2");
    expect(html).toContain("前日");
    expect(html).toContain("今日");
    expect(html).toContain("翌日");
    expect(html).toContain("2026/10/1");
    expect(html).toContain("2026/10/3");
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain("<style");
  });

  it("shows the out-of-range notice on screen", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDatePicker, {
        date: "2026-10-02",
        choices,
        open: false,
        notice: SESSION_DATE_OUT_OF_RANGE_NOTICE,
        onToggle: vi.fn(),
        onSelect: vi.fn(),
        onDismissNotice: vi.fn(),
      }),
    );
    expect(html).toContain(SESSION_DATE_OUT_OF_RANGE_NOTICE);
    expect(html).toContain("閉じる");
    expect(html).not.toContain('class="date-choices"');
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
