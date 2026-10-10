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

export const SESSION_DATE_SAVE_FAILED = "メニューを保存できなかったため、日付を切り替えませんでした";

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

export type SessionDateSwitch =
  | { switched: true; date: string }
  | { switched: false; date: string; reason: "unchanged" | "out_of_window" | "save_failed" };

/**
 * 日付を変える。窓の外と、いまと同じ日付は何もしない。
 * 未保存の DayPlan が保存できたときだけ persist する。失敗時は今の日付に留まる。
 */
export async function switchSessionDate(input: {
  currentDate: string;
  nextDate: string;
  now: Date;
  flush: () => Promise<boolean>;
  persist: (date: string) => void;
}): Promise<SessionDateSwitch> {
  if (input.nextDate === input.currentDate) {
    return { date: input.currentDate, switched: false, reason: "unchanged" };
  }
  if (!isWritableSessionDate(input.nextDate, input.now)) {
    return { date: input.currentDate, switched: false, reason: "out_of_window" };
  }
  const saved = await input.flush();
  if (!saved) return { date: input.currentDate, switched: false, reason: "save_failed" };
  input.persist(input.nextDate);
  return { date: input.nextDate, switched: true };
}

/** 次の東京 0:00 までのミリ秒。ちょうど 0:00 なら次の日まで。 */
export function msUntilNextTokyoDate(now: Date): number {
  const tomorrow = addDays(tokyoCivilDate(now), 1);
  const [year, month, day] = tomorrow.split("-").map(Number);
  const midnight = Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1) - 9 * 60 * 60 * 1000;
  return Math.max(0, midnight - now.getTime());
}

/**
 * 東京の日付が進んで、選んでいた日が窓の外になったときだけ今日へ戻す。
 * 戻す前に未保存の編集を保存する。保存できなければ日付は動かさない。
 */
export async function realignSessionDate(input: {
  selected: string;
  now: Date;
  flush: () => Promise<boolean>;
  persist: (date: string) => void;
}): Promise<{ date: string; notice: string | null; changed: boolean }> {
  if (isWritableSessionDate(input.selected, input.now)) {
    return { date: input.selected, notice: null, changed: false };
  }
  const saved = await input.flush();
  if (!saved) return { date: input.selected, notice: null, changed: false };
  const today = tokyoCivilDate(input.now);
  input.persist(today);
  return { date: today, notice: SESSION_DATE_OUT_OF_RANGE_NOTICE, changed: true };
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
