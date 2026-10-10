import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { Modal } from "../components/Modal";
import { ChevronDownIcon, Icon } from "../components/icons";
import { useClient } from "../clientContext";
import { formatJapaneseDate, formatLogLine, formatMonthDay, type ExerciseLog } from "../domain";
import { useLoad } from "../hooks/useLoad";
import type { Route } from "../route";
import { useSession } from "../session";
import { sessionDateChoices, type SessionDateChoice } from "../sessionDate";

interface PlanRow {
  name: string;
  previous: ExerciseLog[];
  today: ExerciseLog[];
}

/** 記録がある種目を外すときの確認文。Notion の行は残ることを明示する。 */
export function removalConfirmBody(todayCount: number): string {
  return `今日の記録は${todayCount}件あります。メニューから外しても、Notion に保存した記録は削除されません。`;
}

export function TodayExerciseRow({
  index,
  name,
  previous,
  today,
  removable,
  onOpen,
  onRemove,
}: {
  index: number;
  name: string;
  previous: ExerciseLog[];
  today: ExerciseLog[];
  /** 編集中かつ未終了のときだけ。カードの外に置き、タップ領域を分ける。 */
  removable: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  return (
    <li className="plan-item">
      <button type="button" className="exercise-card" onClick={onOpen}>
        <span className="exercise-copy">
          <span className="exercise-name">
            {index + 1}) {name}
          </span>
          {previous.length === 0 ? (
            <span className="exercise-prev">前回 記録なし</span>
          ) : (
            <span className="exercise-prev">
              <span className="log-kicker">前回 {formatMonthDay(previous[0].date)}</span>
              {previous.map((log) => (
                <span key={log.id} className="log-line">
                  {formatLogLine(log)}
                </span>
              ))}
            </span>
          )}
          {today.length > 0 && (
            <span className="exercise-today">
              <span className="log-kicker">今日</span>
              {today.map((log) => (
                <span key={log.id} className="log-line">
                  {formatLogLine(log)}
                </span>
              ))}
            </span>
          )}
        </span>
        <span className={today.length > 0 ? "badge is-done" : "badge"}>
          {today.length > 0 ? `${today.length}件` : "未"}
        </span>
      </button>
      {removable && (
        <button type="button" className="plan-remove" aria-label={`${name}を今日のメニューから外す`} onClick={onRemove}>
          外す
        </button>
      )}
    </li>
  );
}

export function SessionDatePicker({
  date,
  choices,
  open,
  busy = false,
  onToggle,
  onSelect,
}: {
  date: string;
  choices: readonly SessionDateChoice[];
  open: boolean;
  /** 保存待ちのあいだは、別の日付を選べない。 */
  busy?: boolean;
  onToggle: () => void;
  onSelect: (date: string) => void;
}) {
  return (
    <div className="session-date">
      <button
        type="button"
        className="today-date-btn"
        aria-expanded={open}
        aria-controls="session-date-choices"
        aria-busy={busy}
        disabled={busy}
        onClick={onToggle}
      >
        <span>{formatJapaneseDate(date)}</span>
        <Icon>
          <ChevronDownIcon />
        </Icon>
      </button>
      {open && (
        <div id="session-date-choices" className="date-choices" role="group" aria-label="日付を選ぶ">
          {choices.map((choice) => (
            <button
              key={choice.date}
              type="button"
              className={choice.date === date ? "date-choice is-selected" : "date-choice"}
              aria-pressed={choice.date === date}
              disabled={busy}
              onClick={() => onSelect(choice.date)}
            >
              <span className="date-choice-label">{choice.label}</span>
              <span className="date-choice-value">{formatJapaneseDate(choice.date)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function TodayScreen({ navigate }: { navigate: (route: Route) => void }) {
  const session = useSession();
  const client = useClient();
  const auth = useAuth();
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [dateOpen, setDateOpen] = useState(false);
  const [dateChoices, setDateChoices] = useState<SessionDateChoice[]>([]);
  const [pendingDate, setPendingDate] = useState<string | null>(null);
  // 「今日を終了」のあとは再開するまで外せない。終了や空メニューでは編集を閉じる。
  useEffect(() => {
    if (session.finished || session.exercises.length === 0) setEditing(false);
  }, [session.finished, session.exercises.length]);
  const planKey = session.exercises.join("\n");
  const loaded = useLoad(async () => {
    const rows: PlanRow[] = await Promise.all(
      session.exercises.map(async (name) => {
        const [previous, today] = await Promise.all([
          client.getPreviousLog(name, session.date),
          client.getLogOnDate(name, session.date),
        ]);
        return { name, previous, today };
      }),
    );
    return rows;
  }, [planKey, session.date, client]);

  const recordedCount = loaded.data?.filter((row) => row.today.length > 0).length ?? 0;
  const canEditMenu = !session.finished && session.exercises.length > 0;
  const pendingTodayCount = loaded.data?.find((row) => row.name === pendingRemove)?.today.length ?? 0;

  function askRemove(name: string, todayCount: number) {
    if (session.finished) return;
    if (todayCount > 0) {
      setPendingRemove(name);
      return;
    }
    session.removeExercise(name);
  }

  return (
    <section className="screen">
      <div className="today-head">
        <h1 className="today-title">今日のトレーニング</h1>
        {auth.required && auth.email && (
          <button type="button" className="text-btn" onClick={auth.signOut}>
            ログアウト
          </button>
        )}
        <SessionDatePicker
          date={session.date}
          choices={dateChoices}
          open={dateOpen}
          busy={session.dateBusy || pendingDate !== null}
          onToggle={() => {
            if (session.dateBusy || pendingDate) return;
            if (!dateOpen) setDateChoices(sessionDateChoices(new Date()));
            setDateOpen((value) => !value);
          }}
          onSelect={(date) => {
            if (session.dateBusy || pendingDate) return;
            setDateOpen(false);
            if (date === session.date) return;
            if (session.hasUnsavedEdits()) {
              setPendingDate(date);
              return;
            }
            void session.setDate(date, "clean");
          }}
        />
      </div>

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
        <>
          {canEditMenu && (
            <div className="plan-edit-row">
              <h2>種目</h2>
              <button
                type="button"
                className="plan-edit"
                aria-pressed={editing}
                onClick={() => setEditing((value) => !value)}
              >
                {editing ? "完了" : "編集"}
              </button>
            </div>
          )}
          <ul className="plan">
            {session.exercises.map((name, index) => {
              const row = loaded.data?.find((item) => item.name === name);
              const previous = row?.previous ?? [];
              const today = row?.today ?? [];
              return (
                <TodayExerciseRow
                  key={name}
                  index={index}
                  name={name}
                  previous={previous}
                  today={today}
                  removable={editing && canEditMenu}
                  onOpen={() => navigate({ screen: "record", exercise: name })}
                  onRemove={() => askRemove(name, today.length)}
                />
              );
            })}
          </ul>
        </>
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

      {pendingDate && (
        <Modal
          titleId="date-switch-title"
          title="日付を切り替えますか？"
          body="この日付の変更はまだ送られていません。"
          cancelLabel="キャンセル"
          alternateLabel="破棄して切り替える"
          confirmLabel="送信して切り替える"
          onCancel={() => setPendingDate(null)}
          onAlternate={() => {
            const next = pendingDate;
            setPendingDate(null);
            void session.setDate(next, "discard");
          }}
          onConfirm={() => {
            const next = pendingDate;
            setPendingDate(null);
            void session.setDate(next, "save");
          }}
        />
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
            setEditing(false);
            session.finish();
            setConfirmEnd(false);
          }}
        />
      )}

      {pendingRemove && (
        <Modal
          titleId="remove-title"
          title={`「${pendingRemove}」を外しますか？`}
          body={removalConfirmBody(pendingTodayCount)}
          cancelLabel="キャンセル"
          confirmLabel="外す"
          onCancel={() => setPendingRemove(null)}
          onConfirm={() => {
            session.removeExercise(pendingRemove);
            setPendingRemove(null);
          }}
        />
      )}
    </section>
  );
}
