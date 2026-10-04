import type { ExerciseLog } from "../domain";

/** Earlier saves stay ahead of later ones. */
export function chronological(logs: readonly ExerciseLog[]): ExerciseLog[] {
  return [...logs].sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
    if (left.id !== right.id) return left.id < right.id ? -1 : 1;
    return 0;
  });
}

export function logsOnDate(logs: readonly ExerciseLog[], exercise: string, date: string): ExerciseLog[] {
  return chronological(logs.filter((log) => log.exercise === exercise && log.date === date));
}

/**
 * Every row from the latest day strictly before beforeDate on which this exercise was logged.
 * Other exercises do not choose the day, and rows on beforeDate are left out.
 */
export function previousDayLogs(logs: readonly ExerciseLog[], exercise: string, beforeDate: string): ExerciseLog[] {
  let day = "";
  for (const log of logs) {
    if (log.exercise !== exercise || log.date >= beforeDate) continue;
    if (!day || log.date > day) day = log.date;
  }
  if (!day) return [];
  return logsOnDate(logs, exercise, day);
}
