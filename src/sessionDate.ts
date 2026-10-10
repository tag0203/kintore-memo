import { addDays, formatMonthDay, isISODate, tokyoCivilDate } from "./domain";

/**
 * Go API の SessionDateWindowDays と同じ。
 * DayPlan は東京の前日・当日・翌日しか書き込めない。
 */
export const SESSION_DATE_WINDOW_DAYS = 1;

/**
 * 選んだ日付の保存キー。
 * PWA の start_url は "/" で、ホーム画面から開くとクエリは付かない。
 * 経路はハッシュ（#/）なので、URL のクエリは起動のたびに消える。
 * localStorage なら再読み込みでも、ホーム画面からの起動でも残る。
 */
export const SESSION_DATE_STORAGE_KEY = "kintore-memo.session-date";

export const SESSION_DATE_SAVE_FAILED = "保存できませんでした";

export interface SessionDateChoice {
  date: string;
  label: "前日" | "今日" | "翌日";
}

export interface SessionMenu {
  memo: string;
  exercises: string[];
  finished: boolean;
}

export interface SessionDateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const CHOICE_LABELS = ["前日", "今日", "翌日"] as const;

/** 渡した「東京の今日」から前日・当日・翌日を作る。 */
export function sessionDateChoicesFromToday(today: string): SessionDateChoice[] {
  return [-SESSION_DATE_WINDOW_DAYS, 0, SESSION_DATE_WINDOW_DAYS].map((offset, index) => ({
    date: offset === 0 ? today : addDays(today, offset),
    label: CHOICE_LABELS[index],
  }));
}

/** 東京の前日・当日・翌日。これ以外は選べない。 */
export function sessionDateChoices(now: Date): SessionDateChoice[] {
  return sessionDateChoicesFromToday(tokyoCivilDate(now));
}

export function isWritableSessionDate(date: string, now: Date): boolean {
  return sessionDateChoices(now).some((choice) => choice.date === date);
}

/**
 * 画面の「今日」。東京の今日なら「今日」のまま。
 * 前日・翌日は「10/10（前日）」。それ以外の日付も「今日」とは書かない。
 */
export function sessionDateLabel(date: string, now: Date): string {
  const today = tokyoCivilDate(now);
  if (date === today) return "今日";
  const relative = sessionDateChoicesFromToday(today).find((choice) => choice.date === date)?.label;
  const day = formatMonthDay(date);
  if (relative != null && relative !== "今日") return `${day}（${relative}）`;
  return day;
}

/**
 * 保存していた日付を、起動時の選択として使う。
 * 空や壊れた文字列だけ今日。範囲外でも、その日付のまま開く。
 */
export function resolveStoredSessionDate(stored: string | null, now: Date): string {
  if (stored != null && stored !== "" && isISODate(stored)) return stored;
  return tokyoCivilDate(now);
}

export function readStoredSessionDate(storage: SessionDateStorage): string | null {
  try {
    const value = storage.getItem(SESSION_DATE_STORAGE_KEY);
    return value == null || value === "" ? null : value;
  } catch {
    return null;
  }
}

export function writeStoredSessionDate(storage: SessionDateStorage, date: string): void {
  try {
    storage.setItem(SESSION_DATE_STORAGE_KEY, date);
  } catch {
    // プライベートモードなどで書けないときは、この起動中の state だけを使う。
  }
}

/**
 * 読み込めた日付だけ保存する。失敗して直前の日付があれば、そこへ戻し、保存はしない。
 */
export function sessionDateAfterLoad(input: {
  requested: string;
  ok: boolean;
  previous: string | null;
}): { date: string; persist: boolean } {
  if (input.ok) return { date: input.requested, persist: true };
  if (input.previous != null && input.previous !== input.requested) {
    return { date: input.previous, persist: false };
  }
  return { date: input.requested, persist: false };
}

export type DateSwitchChoice = "clean" | "save" | "discard";

export type SessionDateSwitch =
  | { switched: true; date: string }
  | { switched: false; date: string; reason: "unchanged" | "save_failed" };

/**
 * 日付を変える。未保存を送るときは、保存できたときだけ persist する。
 * 破棄するときは送らずに persist する。
 */
export async function switchSessionDate(input: {
  currentDate: string;
  nextDate: string;
  choice: DateSwitchChoice;
  flush: () => Promise<boolean>;
  discard: () => void;
  persist: (date: string) => void;
}): Promise<SessionDateSwitch> {
  if (input.nextDate === input.currentDate) {
    return { date: input.currentDate, switched: false, reason: "unchanged" };
  }
  if (input.choice === "discard") {
    input.discard();
    input.persist(input.nextDate);
    return { date: input.nextDate, switched: true };
  }
  const saved = await input.flush();
  if (!saved) return { date: input.currentDate, switched: false, reason: "save_failed" };
  input.persist(input.nextDate);
  return { date: input.nextDate, switched: true };
}

/** DayPlan の応答を、その日付のメニューとして使う。finished は日付ごとに別。 */
export function menuFromDayPlan(plan: {
  memo: string;
  exercises: readonly string[];
  finished: boolean;
}): SessionMenu {
  return { memo: plan.memo, exercises: [...plan.exercises], finished: plan.finished };
}

/** モック経路で、離れる日付のメニューを残す。配列は共有しない。 */
export function storeMenu(menus: Map<string, SessionMenu>, date: string, menu: SessionMenu): void {
  menus.set(date, { memo: menu.memo, exercises: [...menu.exercises], finished: menu.finished });
}

/** まだ開いていない日付は空。finished は前の日付から引き継がない。 */
export function recallMenu(menus: ReadonlyMap<string, SessionMenu>, date: string): SessionMenu {
  const found = menus.get(date);
  if (!found) return { memo: "", exercises: [], finished: false };
  return { memo: found.memo, exercises: [...found.exercises], finished: found.finished };
}
