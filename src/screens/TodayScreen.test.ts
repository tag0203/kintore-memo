import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "../components/Modal";
import type { ExerciseLog } from "../domain";
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
        onToggle: vi.fn(),
        onSelect: vi.fn(),
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

  it("disables the choices while a date switch is saving", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDatePicker, {
        date: "2026-10-02",
        choices,
        open: true,
        busy: true,
        onToggle: vi.fn(),
        onSelect: vi.fn(),
      }),
    );
    expect(html.match(/disabled/g)?.length).toBe(4);
  });
});

describe("date switch choice", () => {
  it("offers discard or send before leaving unsaved edits", () => {
    const html = renderToStaticMarkup(
      createElement(Modal, {
        titleId: "date-switch-title",
        title: "日付を切り替えますか？",
        body: "この日付の変更はまだ送られていません。",
        cancelLabel: "キャンセル",
        alternateLabel: "破棄して切り替える",
        confirmLabel: "送信して切り替える",
        onCancel: vi.fn(),
        onAlternate: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );
    expect(html).toContain("破棄して切り替える");
    expect(html).toContain("送信して切り替える");
    expect(html).toContain("キャンセル");
    expect(html).not.toContain("disabled");
    expect(html).not.toContain("<style");
  });

  it("disables discard while a save request is in flight", () => {
    const html = renderToStaticMarkup(
      createElement(Modal, {
        titleId: "date-switch-title",
        title: "日付を切り替えますか？",
        body: "この日付の変更はまだ送られていません。",
        cancelLabel: "キャンセル",
        alternateLabel: "保存しています…",
        alternateDisabled: true,
        confirmLabel: "送信して切り替える",
        onCancel: vi.fn(),
        onAlternate: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );
    expect(html).toContain("保存しています…");
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("破棄して切り替える");
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
