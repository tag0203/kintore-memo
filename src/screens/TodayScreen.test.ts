import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "../components/Modal";
import type { ExerciseLog } from "../domain";
import { SessionDatePicker, TodayExerciseRow, removalConfirmBody, shouldReloadLogs, todayFinishView } from "./TodayScreen";

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
    expect(html).toContain("今日");
  });

  it("labels logs and removal with the selected date when it is not today", () => {
    const html = renderToStaticMarkup(
      createElement(TodayExerciseRow, {
        index: 0,
        name: "スクワット",
        previous: [],
        today: [log("a")],
        removable: true,
        dateLabel: "10/10（前日）",
        onOpen: vi.fn(),
        onRemove: vi.fn(),
      }),
    );
    expect(html).toContain("10/10（前日）");
    expect(html).toContain("スクワットを10/10（前日）のメニューから外す");
    expect(html).not.toContain(">今日<");
  });

  it("shows 未 and keeps 修正 and 削除 outside the card while a row is unsynced", () => {
    const html = renderToStaticMarkup(
      createElement(TodayExerciseRow, {
        index: 0,
        name: "スクワット",
        previous: [],
        today: [{ ...log("draft-1"), synced: false }],
        removable: false,
        onOpen: vi.fn(),
        onRemove: vi.fn(),
        onEditDraft: vi.fn(),
        onDeleteDraft: vi.fn(),
      }),
    );
    const card = html.slice(0, html.indexOf("</button>") + "</button>".length);
    expect(card).toContain("未");
    expect(card).not.toContain("is-done");
    expect(card).not.toContain("修正");
    expect(card).not.toContain("削除");
    expect(html).toContain("修正");
    expect(html).toContain("スクワットの下書きを削除");
  });

  it("drops 未 once the row is synced", () => {
    const html = renderToStaticMarkup(
      createElement(TodayExerciseRow, {
        index: 0,
        name: "スクワット",
        previous: [],
        today: [{ ...log("draft-1"), synced: true }],
        removable: false,
        onOpen: vi.fn(),
        onRemove: vi.fn(),
      }),
    );
    expect(html).toContain("1件");
    expect(html).not.toContain("未");
    expect(html).not.toContain("修正");
  });
});

describe("todayFinishView", () => {
  it("hides 再開する after the day was sent to Notion", () => {
    expect(todayFinishView(true, "synced")).toEqual({
      showResume: false,
      showAdd: false,
      showEnd: false,
      showRetry: false,
      message: "送信済み。修正は Notion で",
    });
  });

  it("shows 反映中 while the worker is writing, and a retry after failure", () => {
    expect(todayFinishView(true, "flushing").message).toBe("反映中");
    expect(todayFinishView(true, "flushing").showResume).toBe(false);
    expect(todayFinishView(true, "failed")).toMatchObject({
      showResume: false,
      showRetry: true,
      message: "失敗。もう一度終了を",
    });
  });

  it("keeps 再開する when the menu is closed and Notion has not been sent", () => {
    expect(todayFinishView(true, "open").showResume).toBe(true);
    expect(todayFinishView(false, "open").showEnd).toBe(true);
  });

  it("reloads rows only when a flush reaches synced", () => {
    expect(shouldReloadLogs("flushing")).toBe(false);
    expect(shouldReloadLogs("failed")).toBe(false);
    expect(shouldReloadLogs("open")).toBe(false);
    expect(shouldReloadLogs("synced")).toBe(true);
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
    expect(body).toContain("今日の記録は2件あります");
  });

  it("names the selected date when it is not today", () => {
    expect(removalConfirmBody(1, "10/12（翌日）")).toContain("10/12（翌日）の記録は1件あります");
  });
});
