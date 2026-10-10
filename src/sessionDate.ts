import { addDays, tokyoCivilDate } from "./domain";

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

export const SESSION_DATE_OUT_OF_RANGE_NOTICE =
  "選んでいた日付は前日〜翌日の範囲外になったため、今日に戻しました。";

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

/** 東京の前日・当日・翌日。これ以外は選べない。 */
export function sessionDateChoices(now: Date): SessionDateChoice[] {
  const today = tokyoCivilDate(now);
  return [-SESSION_DATE_WINDOW_DAYS, 0, SESSION_DATE_WINDOW_DAYS].map((offset, index) => ({
    date: offset === 0 ? today : addDays(today, offset),
    label: CHOICE_LABELS[index],
  }));
}

export function isWritableSessionDate(date: string, now: Date): boolean {
  return sessionDateChoices(now).some((choice) => choice.date === date);
}

/**
 * 保存していた日付を、いまの東京の窓に合わせて決める。
 * 空なら今日。窓の外（2日以上ずれ、壊れた文字列）なら今日に戻し、notice を返す。
 */
export function resolveStoredSessionDate(
  stored: string | null,
  now: Date,
): { date: string; notice: string | null } {
  const today = tokyoCivilDate(now);
  if (stored == null || stored === "") return { date: today, notice: null };
  if (isWritableSessionDate(stored, now)) return { date: stored, notice: null };
  return { date: today, notice: SESSION_DATE_OUT_OF_RANGE_NOTICE };
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
 * 日付を変える。窓の外と、いまと同じ日付は何もしない。
 * 変えるときは、保存してから persist する。途中の DayPlan を捨てないため。
 */
export async function switchSessionDate(input: {
  currentDate: string;
  nextDate: string;
  now: Date;
  flush: () => Promise<void>;
  persist: (date: string) => void;
}): Promise<{ date: string; switched: boolean }> {
  if (!isWritableSessionDate(input.nextDate, input.now) || input.nextDate === input.currentDate) {
    return { date: input.currentDate, switched: false };
  }
  await input.flush();
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
