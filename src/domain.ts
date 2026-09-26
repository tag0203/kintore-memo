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

export function parseWeight(raw: string): number | null {
  const text = raw.trim().replace(/,/g, ".");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const value = Number(text);
  if (value <= 0 || value > 999) return null;
  return Math.round(value * 100) / 100;
}

export function parseCount(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  if (value <= 0 || value > 999) return null;
  return value;
}

export function isISODate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}
