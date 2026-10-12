import { useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { Modal } from "../components/Modal";
import { ChevronDownIcon, Icon } from "../components/icons";
import { useClient } from "../clientContext";
import type { DayFlushStatus } from "../data/client";
import { formatJapaneseDate, formatLogLine, formatMonthDay, type ExerciseLog } from "../domain";
import { useLoad } from "../hooks/useLoad";
import type { Route } from "../route";
import { useSession } from "../session";
import { sessionDateChoices, sessionDateLabel, type SessionDateChoice } from "../sessionDate";

interface PlanRow {
  name: string;
  previous: ExerciseLog[];
  today: ExerciseLog[];
}

/** flushing から synced に変わったとき、表示中の行を取り直す。反映中の「未」を残さない。 */
export function shouldReloadLogs(status: DayFlushStatus): boolean {
  return status === "synced";
}

/** 終了ボタンの代わりに出す文言。送信済みの日は再開できない。 */
export function todayFinishView(menuFinished: boolean, status: DayFlushStatus): {
  showResume: boolean;
  showAdd: boolean;
  showEnd: boolean;
  showRetry: boolean;
  message: string | null;
} {
  if (status === "synced") {
    return { showResume: false, showAdd: false, showEnd: false, showRetry: false, message: "送信済み。修正は Notion で" };
  }
  if (status === "flushing") {
    return { showResume: false, showAdd: false, showEnd: false, showRetry: false, message: "反映中" };
  }
  if (status === "failed") {
    return {
      showResume: false,
      showAdd: !menuFinished,
      showEnd: !menuFinished,
      showRetry: menuFinished,
      message: "失敗。もう一度終了を",
    };
  }
  if (menuFinished) {
    return { showResume: true, showAdd: false, showEnd: false, showRetry: false, message: null };
  }
  return { showResume: false, showAdd: true, showEnd: true, showRetry: false, message: null };
}

/** 記録がある種目を外すときの確認文。Notion の行は残ることを明示する。 */
export function removalConfirmBody(todayCount: number, dateLabel = "今日"): string {
  return `${dateLabel}の記録は${todayCount}件あります。メニューから外しても、Notion に保存した記録は削除されません。`;
}

export function TodayExerciseRow({
  index,
  name,
  previous,
  today,
  removable,
  dateLabel = "今日",
  onOpen,
  onRemove,
  onEditDraft,
  onDeleteDraft,
  draftsEditable = true,
}: {
  index: number;
  name: string;
  previous: ExerciseLog[];
  today: ExerciseLog[];
  /** 編集中かつ未終了のときだけ。カードの外に置き、タップ領域を分ける。 */
  removable: boolean;
  /** 東京の今日なら「今日」。それ以外は「10/10（前日）」。 */
  dateLabel?: string;
  onOpen: () => void;
  onRemove: () => void;
  /** 未反映の下書きだけ。カードの外に置く。 */
  onEditDraft?: (log: ExerciseLog) => void;
  onDeleteDraft?: (log: ExerciseLog) => void;
  /** 反映中と送信済みは、下書きの修正と削除を出さない。 */
  draftsEditable?: boolean;
}) {
  const drafts = today.filter((log) => log.synced === false);
  const unsynced = drafts.length > 0;
  const badgeText = unsynced || today.length === 0 ? "未" : `${today.length}件`;
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
              <span className="log-kicker">{dateLabel}</span>
              {today.map((log) => (
                <span key={log.id} className="log-line">
                  {formatLogLine(log)}
                </span>
              ))}
            </span>
          )}
        </span>
        <span className={today.length > 0 && !unsynced ? "badge is-done" : "badge"}>{badgeText}</span>
      </button>
      {draftsEditable &&
        drafts.map((log) => (
        <div key={log.id} className="draft-actions">
          <button type="button" className="draft-action" onClick={() => onEditDraft?.(log)}>
            修正
          </button>
          <button
            type="button"
            className="draft-action is-danger"
            aria-label={`${name}の下書きを削除`}
            onClick={() => onDeleteDraft?.(log)}
          >
            削除
          </button>
        </div>
      ))}
      {removable && (
        <button type="button" className="plan-remove" aria-label={`${name}を${dateLabel}のメニューから外す`} onClick={onRemove}>
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
  const dateLabel = sessionDateLabel(session.date, new Date());
  const client = useClient();
  const auth = useAuth();
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);
  const [notionStatus, setNotionStatus] = useState<DayFlushStatus>("open");
  const [editing, setEditing] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ExerciseLog | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [logsRevision, setLogsRevision] = useState(0);
  const endingRef = useRef(false);
  const deletingRef = useRef(false);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [dateOpen, setDateOpen] = useState(false);
  const [dateChoices, setDateChoices] = useState<SessionDateChoice[]>([]);
  const [pendingDate, setPendingDate] = useState<string | null>(null);
  // 確認を出しているあいだは未送信の自動保存を止め、閉じたら再開する。
  useEffect(() => {
    if (pendingDate == null) return;
    session.pauseAutoSave();
    return () => {
      session.resumeAutoSave();
    };
  }, [pendingDate, session.pauseAutoSave, session.resumeAutoSave]);
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
  }, [planKey, session.date, client, logsRevision]);

  useEffect(() => {
    setNotionStatus(client.dayStatus(session.date));
    setEndError(null);
  }, [session.date, client, loaded.data, logsRevision]);

  useEffect(() => {
    if (notionStatus !== "flushing") return;
    let stop = false;
    const timer = setInterval(() => {
      void client
        .refreshDayStatus(session.date)
        .then((status) => {
          if (stop) return;
          setNotionStatus(status);
          if (status === "synced") session.finish();
          if (shouldReloadLogs(status)) setLogsRevision((value) => value + 1);
        })
        .catch(() => {
          if (!stop) setNotionStatus("failed");
        });
    }, 2000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [notionStatus, session, client]);

  const recordedCount = loaded.data?.filter((row) => row.today.length > 0).length ?? 0;
  const finishView = todayFinishView(session.finished, notionStatus);
  const draftsEditable = notionStatus === "open" || notionStatus === "failed";
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

  async function confirmFinish() {
    if (endingRef.current) return;
    endingRef.current = true;
    setEnding(true);
    setEndError(null);
    try {
      const status = await client.finishDay(session.date);
      setNotionStatus(status);
      setEditing(false);
      if (status === "synced" || status === "flushing") session.finish();
      setConfirmEnd(false);
      setLogsRevision((value) => value + 1);
      if (status === "failed") setEndError("失敗。もう一度終了を");
    } catch (reason) {
      setEndError(reason instanceof Error ? reason.message : "Notion への反映に失敗しました");
    } finally {
      endingRef.current = false;
      setEnding(false);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete || deletingRef.current) return;
    deletingRef.current = true;
    setDeleteError(null);
    try {
      await client.deleteLog(pendingDelete.id);
      setPendingDelete(null);
      setLogsRevision((value) => value + 1);
    } catch (reason) {
      setDeleteError(reason instanceof Error ? reason.message : "削除に失敗しました");
    } finally {
      deletingRef.current = false;
    }
  }

  return (
    <section className="screen">
      <div className="today-head">
        <h1 className="today-title">{dateLabel}のトレーニング</h1>
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
              session.pauseAutoSave();
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
          {finishView.message && <p>{finishView.message}</p>}
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
                  dateLabel={dateLabel}
                  onOpen={() => navigate({ screen: "record", exercise: name })}
                  draftsEditable={draftsEditable}
                  onEditDraft={
                    draftsEditable
                      ? (log) => navigate({ screen: "record", exercise: name, draftId: log.id })
                      : undefined
                  }
                  onDeleteDraft={
                    draftsEditable
                      ? (log) => {
                          setDeleteError(null);
                          setPendingDelete(log);
                        }
                      : undefined
                  }
                  onRemove={() => askRemove(name, today.length)}
                />
              );
            })}
          </ul>
        </>
      )}

      {finishView.message && !session.finished && (
        <p className="status-line" role="status">
          {finishView.message}
        </p>
      )}

      {finishView.showResume ? (
        <div className="action-row single">
          <button type="button" className="btn primary" onClick={session.resume}>
            再開する
          </button>
        </div>
      ) : null}

      {finishView.showAdd ? (
        <div className="action-row">
          <button type="button" className="btn primary" onClick={() => navigate({ screen: "picker" })}>
            種目を追加
          </button>
          {finishView.showEnd && (
            <button type="button" className="btn secondary" onClick={() => setConfirmEnd(true)}>
              {dateLabel}を終了
            </button>
          )}
        </div>
      ) : null}

      {finishView.showRetry ? (
        <div className="action-row single">
          <button type="button" className="btn secondary" onClick={() => void confirmFinish()}>
            もう一度終了する
          </button>
        </div>
      ) : null}

      {pendingDate && (
        <Modal
          titleId="date-switch-title"
          title="日付を切り替えますか？"
          body="この日付の変更はまだ送られていません。"
          cancelLabel="キャンセル"
          alternateLabel={session.menuSaving ? "保存しています…" : "破棄して切り替える"}
          alternateDisabled={session.menuSaving}
          confirmLabel="送信して切り替える"
          onCancel={() => setPendingDate(null)}
          onAlternate={() => {
            if (session.menuSaving) return;
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
          title={`${dateLabel}のトレーニングを終了しますか？`}
          body={
            endError ??
            "終了すると記録を Notion に反映します。反映した記録はアプリから修正できません。"
          }
          cancelLabel="キャンセル"
          confirmLabel={ending ? "反映しています…" : "終了する"}
          onCancel={() => {
            if (ending) return;
            setEndError(null);
            setConfirmEnd(false);
          }}
          onConfirm={() => {
            void confirmFinish();
          }}
        />
      )}

      {pendingDelete && (
        <Modal
          titleId="delete-draft-title"
          title="この下書きを削除しますか？"
          body={deleteError ?? "未反映の記録だけを消します。Notion にはまだ書いていません。"}
          cancelLabel="キャンセル"
          confirmLabel="削除する"
          onCancel={() => {
            setDeleteError(null);
            setPendingDelete(null);
          }}
          onConfirm={() => {
            void confirmDelete();
          }}
        />
      )}

      {pendingRemove && (
        <Modal
          titleId="remove-title"
          title={`「${pendingRemove}」を外しますか？`}
          body={removalConfirmBody(pendingTodayCount, dateLabel)}
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
