import type { ExerciseLog, ExerciseSummary, NewExerciseLog } from "../domain";

/**
 * トレーニング記録の読み書き口。
 * ブラウザはインメモリのモック実装だけを使う。本番 API への差し替えは #12。
 * Notion の本番経路は Lambda（backend/）。worker/ は参考で、画面のバンドルには入れない。
 */
export interface WorkoutLogClient {
  listExercises(): Promise<ExerciseSummary[]>;
  listRecentExercises(): Promise<ExerciseSummary[]>;
  /** 指定日より前で、その種目の最新1行。今日の行は前回に含めない。 */
  getPreviousLog(exercise: string, beforeDate: string): Promise<ExerciseLog | null>;
  /** その日に保存した最新1行。無ければ null。 */
  getLogOnDate(exercise: string, date: string): Promise<ExerciseLog | null>;
  /** 追記のみ。既存行は更新しない。 */
  createLog(input: NewExerciseLog): Promise<ExerciseLog>;
  /** ピッカーで選んだ順を更新する。未知の名前ならカタログに足す。 */
  touchExercise(name: string, atISO: string): Promise<ExerciseSummary>;
}
