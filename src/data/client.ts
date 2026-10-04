import type { ExerciseLog, ExerciseSummary, NewExerciseLog } from "../domain";

/**
 * トレーニング記録の読み書き口。
 * 本番は API Gateway（Cognito の JWT のみ）。API ベース URL が無いときはインメモリのモック。
 * Notion のトークンはブラウザに置かない。worker/ は参考で、画面のバンドルには入れない。
 */
export interface WorkoutLogClient {
  listExercises(): Promise<ExerciseSummary[]>;
  listRecentExercises(): Promise<ExerciseSummary[]>;
  /** 今日より前で、その種目を最後にやった日の行をすべて。今日の行は含めない。 */
  getPreviousLog(exercise: string, beforeDate: string): Promise<ExerciseLog[]>;
  /** その日に保存した行をすべて。無ければ空。 */
  getLogOnDate(exercise: string, date: string): Promise<ExerciseLog[]>;
  /** 追記のみ。既存行は更新しない。 */
  createLog(input: NewExerciseLog): Promise<ExerciseLog>;
  /** ピッカーで選んだ順を更新する。未知の名前ならカタログに足す。 */
  touchExercise(name: string, atISO: string): Promise<ExerciseSummary>;
}
