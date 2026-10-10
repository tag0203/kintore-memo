export type Difficulty = 1 | 2 | 3 | 4 | 5;

export interface ExerciseLog {
  id: string;
  exercise: string;
  weightKg: number;
  reps: number;
  sets: number;
  difficulty: Difficulty;
  /** YYYY-MM-DD */
  date: string;
  /** Notion のタイトル。記録行では「－」を入れる。 */
  title: string;
  createdAt: string;
}

export interface NewExerciseLog {
  exercise: string;
  weightKg: number;
  reps: number;
  sets: number;
  difficulty: Difficulty;
  date: string;
  title?: string;
}

export interface ExerciseSummary {
  name: string;
  lastPickedAt: string | null;
}

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  1: "とても楽",
  2: "楽",
  3: "ややきつい",
  4: "きつい",
  5: "とてもきつい",
};

export const DIFFICULTIES: readonly Difficulty[] = [1, 2, 3, 4, 5];

/** Notion のページタイトルに入れる全角ハイフン。 */
export const PAGE_TITLE = "－";

export function isDifficulty(value: number): value is Difficulty {
  return DIFFICULTIES.includes(value as Difficulty);
}

export function difficultyFromLabel(label: string): Difficulty | null {
  const found = DIFFICULTIES.find((level) => DIFFICULTY_LABELS[level] === label);
  return found ?? null;
}

export function toISODate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Go の TokyoCivilDate と同じ。UTC に 9 時間足した暦日で、端末のタイムゾーンは使わない。 */
const TOKYO_OFFSET_MS = 9 * 60 * 60 * 1000;

/** Asia/Tokyo の YYYY-MM-DD。 */
export function tokyoCivilDate(now: Date): string {
  const shifted = new Date(now.getTime() + TOKYO_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const next = new Date(year, (month ?? 1) - 1, day ?? 1);
  next.setDate(next.getDate() + days);
  return toISODate(next);
}

export function formatJapaneseDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  return `${year}/${month}/${day}`;
}

export function formatMonthDay(isoDate: string): string {
  const [, month, day] = isoDate.split("-").map(Number);
  return `${month}/${day}`;
}

export function formatWeight(weightKg: number): string {
  if (Number.isInteger(weightKg)) return String(weightKg);
  return String(Math.round(weightKg * 100) / 100);
}

export function formatSetSummary(log: Pick<ExerciseLog, "weightKg" | "reps" | "sets">): string {
  return `${formatWeight(log.weightKg)}kg × ${log.reps} × ${log.sets}`;
}

export function formatLogLine(log: Pick<ExerciseLog, "weightKg" | "reps" | "sets" | "difficulty">): string {
  return `${formatSetSummary(log)} · ${DIFFICULTY_LABELS[log.difficulty]}`;
}

/** 画面の重量入力と同じ。0 より大きく 999 以下、小数は2桁まで。 */
export function isValidWeightKg(value: number): boolean {
  if (!Number.isFinite(value) || value <= 0 || value > 999) return false;
  const cents = Math.round(value * 100);
  return Math.abs(value * 100 - cents) < 1e-6;
}

/** 画面の回数・セット入力と同じ。1 以上 999 以下の整数。 */
export function isValidCount(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 999;
}

export function parseWeight(raw: string): number | null {
  const text = raw.trim().replace(/,/g, ".");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const value = Number(text);
  if (!isValidWeightKg(value)) return null;
  return Math.round(value * 100) / 100;
}

export function parseCount(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  if (!isValidCount(value)) return null;
  return value;
}

export function isISODate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}
