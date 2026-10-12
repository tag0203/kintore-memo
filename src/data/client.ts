import type { ExerciseLog, ExerciseSummary, NewExerciseLog } from "../domain";

/** その日の Notion 反映。終了は受付だけ返し、画面はこれを見て待つ。 */
export type DayFlushStatus = "open" | "flushing" | "synced" | "failed";

/**
 * トレーニング記録の読み書き口。
 * 本番は API Gateway（Cognito の JWT のみ）。API ベース URL が無いときはインメモリのモック。
 * Notion のトークンはブラウザに置かない。worker/ は参考で、画面のバンドルには入れない。
 */
export interface WorkoutLogClient {
  /** onDate を渡すと、そのセッション日のキャッシュを使う。省略時は今のキャッシュか東京の今日。 */
  listExercises(onDate?: string): Promise<ExerciseSummary[]>;
  listRecentExercises(onDate?: string): Promise<ExerciseSummary[]>;
  /** 今日より前で、その種目を最後にやった日の行をすべて。今日の行は含めない。 */
  getPreviousLog(exercise: string, beforeDate: string): Promise<ExerciseLog[]>;
  /** その日に保存した行をすべて。無ければ空。 */
  getLogOnDate(exercise: string, date: string): Promise<ExerciseLog[]>;
  /** 下書きを1行追加する。Notion にはまだ書かない。 */
  createLog(input: NewExerciseLog): Promise<ExerciseLog>;
  /** 未反映の下書きだけを書き換える。 */
  updateLog(id: string, input: NewExerciseLog): Promise<ExerciseLog>;
  /** 未反映の下書きだけを消す。 */
  deleteLog(id: string): Promise<void>;
  /** その日の下書きの反映を受け付ける。Notion への書き込みは別の処理が行う。 */
  finishDay(date: string): Promise<DayFlushStatus>;
  /** 反映の進み具合を取り直す。終了のあと、反映中ならこれを繰り返す。 */
  refreshDayStatus(date: string): Promise<DayFlushStatus>;
  /** 直近に知っている反映状態。まだ見ていなければ open。 */
  dayStatus(date: string): DayFlushStatus;
  /** 反映中または反映済みなら true。下書きの修正と削除はできない。 */
  isDayClosed(date: string): boolean;
  /** 保存した種目の「最近」順を更新する。未知の名前ならカタログに足す。onDate はそのセッション日。 */
  touchExercise(name: string, atISO: string, onDate?: string): Promise<ExerciseSummary>;
}
