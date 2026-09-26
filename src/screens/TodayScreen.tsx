import { useState } from "react";
import { Modal } from "../components/Modal";
import { useClient } from "../clientContext";
import { formatJapaneseDate, formatSetSummary, type ExerciseLog } from "../domain";
import { useLoad } from "../hooks/useLoad";
import type { Route } from "../route";
import { useSession } from "../session";

interface PlanRow {
  name: string;
  previous: ExerciseLog | null;
  recorded: boolean;
}

export function TodayScreen({ navigate }: { navigate: (route: Route) => void }) {
  const session = useSession();
  const client = useClient();
  const [confirmEnd, setConfirmEnd] = useState(false);
  const planKey = session.exercises.join("\n");
  const loaded = useLoad(async () => {
    const rows: PlanRow[] = await Promise.all(
      session.exercises.map(async (name) => {
        const [previous, todayLog] = await Promise.all([
          client.getPreviousLog(name, session.date),
          client.getLogOnDate(name, session.date),
        ]);
        return { name, previous, recorded: todayLog != null };
      }),
    );
    return rows;
  }, [planKey, session.date, client]);

  const recordedCount = loaded.data?.filter((row) => row.recorded).length ?? 0;

  return (
    <section className="screen">
      <h1 className="today-title">今日のトレーニング</h1>
      <p className="today-date">{formatJapaneseDate(session.date)}</p>

      {session.finished && (
        <div className="done-banner" role="status">
          <strong>お疲れさまでした</strong>
          <p>
            記録した種目 {recordedCount} / {session.exercises.length}
          </p>
        </div>
      )}

      <h2 className="section-label">部位メモ</h2>
      <p className="section-hint">任意・1行でメモを入力</p>
      <input
        className="text-input"
        value={session.memo}
        placeholder="例: 脚"
        maxLength={80}
        aria-label="部位メモ"
        onChange={(event) => session.setMemo(event.target.value)}
      />

      {loaded.status === "error" && (
        <div className="status-line">
          <p className="text-error">{loaded.error}</p>
          <button type="button" className="btn secondary" onClick={loaded.reload}>
            再読み込み
          </button>
        </div>
      )}

      {loaded.data == null && loaded.status === "loading" && <p className="status-line">読み込み中…</p>}

      {loaded.data && session.exercises.length === 0 && (
        <p className="empty">
          種目はまだありません。
          <br />
          下のボタンから追加できます。
        </p>
      )}

      {loaded.data && session.exercises.length > 0 && (
        <ul className="plan">
          {session.exercises.map((name, index) => {
            const row = loaded.data?.find((item) => item.name === name);
            const recorded = row?.recorded ?? false;
            return (
              <li key={name}>
                <button
                  type="button"
                  className="exercise-card"
                  onClick={() => navigate({ screen: "record", exercise: name })}
                >
                  <span className="exercise-copy">
                    <span className="exercise-name">
                      {index + 1}) {name}
                    </span>
                    <span className="exercise-prev">
                      {row?.previous ? `前回 ${formatSetSummary(row.previous)}` : "前回 記録なし"}
                    </span>
                  </span>
                  <span className={recorded ? "badge is-done" : "badge"}>{recorded ? "記録済" : "未"}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {session.finished ? (
        <div className="action-row single">
          <button type="button" className="btn primary" onClick={session.resume}>
            再開する
          </button>
        </div>
      ) : (
        <div className="action-row">
          <button type="button" className="btn primary" onClick={() => navigate({ screen: "picker" })}>
            種目を追加
          </button>
          <button type="button" className="btn secondary" onClick={() => setConfirmEnd(true)}>
            今日を終了
          </button>
        </div>
      )}

      {confirmEnd && (
        <Modal
          titleId="end-title"
          title="今日のトレーニングを終了しますか？"
          body={`記録済み ${recordedCount} / ${session.exercises.length} 種目です。終了後も「再開する」で続けられます。`}
          cancelLabel="キャンセル"
          confirmLabel="終了する"
          onCancel={() => setConfirmEnd(false)}
          onConfirm={() => {
            session.finish();
            setConfirmEnd(false);
          }}
        />
      )}
    </section>
  );
}
