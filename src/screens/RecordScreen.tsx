import { useEffect, useRef, useState, type FormEvent } from "react";
import { DifficultyFaces } from "../components/Difficulty";
import { BackIcon, ChevronDownIcon, Icon, PencilIcon, SaveIcon } from "../components/icons";
import { Modal } from "../components/Modal";
import { useClient } from "../clientContext";
import {
  DIFFICULTY_LABELS,
  PAGE_TITLE,
  formatMonthDay,
  formatWeight,
  parseCount,
  parseWeight,
  type Difficulty,
  type ExerciseLog,
} from "../domain";
import { useLoad } from "../hooks/useLoad";
import type { Route } from "../route";
import { useSession } from "../session";
import { sessionDateLabel } from "../sessionDate";

interface Draft {
  weight: string;
  reps: string;
  sets: string;
  difficulty: Difficulty | null;
}

function draftFromLog(log: ExerciseLog): Draft {
  return {
    weight: formatWeight(log.weightKg),
    reps: String(log.reps),
    sets: String(log.sets),
    difficulty: log.difficulty,
  };
}

const emptyDraft: Draft = { weight: "", reps: "", sets: "", difficulty: null };

/**
 * 記録の保存が成功したあとに、その日のメニューへ足し、「最近」を更新する。
 * 時刻は createLog が返した createdAt。端末時計では上書きしない。
 * touch が失敗しても記録自体は成功のまま。詳細はコンソールに残す。
 */
export async function persistRecordedExercise(input: {
  exercise: string;
  date: string;
  createLog: () => Promise<{ createdAt: string }>;
  addExercise: (name: string) => void;
  touchExercise: (name: string, atISO: string, onDate: string) => Promise<unknown>;
}): Promise<void> {
  const saved = await input.createLog();
  input.addExercise(input.exercise);
  try {
    await input.touchExercise(input.exercise, saved.createdAt, input.date);
  } catch (reason) {
    console.error("touch exercise failed", reason);
  }
}

export function RecordScreen({
  exercise,
  navigate,
  back,
}: {
  exercise: string;
  navigate: (route: Route) => void;
  back: () => void;
}) {
  const client = useClient();
  const session = useSession();
  const dateLabel = sessionDateLabel(session.date, new Date());
  const weightRef = useRef<HTMLInputElement>(null);
  const repsRef = useRef<HTMLInputElement>(null);
  const setsRef = useRef<HTMLInputElement>(null);
  const loaded = useLoad(
    () =>
      Promise.all([
        client.getPreviousLog(exercise, session.date),
        client.getLogOnDate(exercise, session.date),
      ]),
    [client, exercise, session.date],
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    if (loaded.status !== "ready" || !loaded.data || draft) return;
    const [previous, todayLogs] = loaded.data;
    const seed = todayLogs.at(-1) ?? previous.at(-1);
    const next = seed ? draftFromLog(seed) : emptyDraft;
    setDraft(next);
    setBaseline(JSON.stringify(next));
  }, [loaded.status, loaded.data, draft]);

  const previous = loaded.data?.[0] ?? [];
  const todayLogs = loaded.data?.[1] ?? [];
  const dirty = draft != null && JSON.stringify(draft) !== baseline;

  function update(partial: Partial<Draft>) {
    setDraft((current) => (current ? { ...current, ...partial } : current));
    setError(null);
  }

  function leave() {
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    back();
  }

  async function onSave(event: FormEvent) {
    event.preventDefault();
    if (!draft || saving) return;
    const weightKg = parseWeight(draft.weight);
    const reps = parseCount(draft.reps);
    const sets = parseCount(draft.sets);
    const difficulty = draft.difficulty;
    if (weightKg == null || reps == null || sets == null || difficulty == null) {
      setError("重量・回数・セット・きつさを入力してください");
      return;
    }
    setSaving(true);
    try {
      await persistRecordedExercise({
        exercise,
        date: session.date,
        createLog: () =>
          client.createLog({
            exercise,
            weightKg,
            reps,
            sets,
            difficulty,
            date: session.date,
            title: PAGE_TITLE,
          }),
        addExercise: (name) => {
          session.addExercise(name);
        },
        touchExercise: (name, atISO, onDate) => client.touchExercise(name, atISO, onDate),
      });
      navigate({ screen: "today" });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存できませんでした");
      setSaving(false);
    }
  }

  return (
    <section className="screen record">
      <header className="nav">
        <button type="button" className="back-btn" onClick={leave} aria-label="戻る">
          <Icon>
            <BackIcon />
          </Icon>
        </button>
        <h1>{exercise}</h1>
        <span />
      </header>
      {dateLabel !== "今日" && <p className="section-hint">{dateLabel}</p>}

      {loaded.status === "error" && (
        <div className="status-line">
          <p className="text-error">{loaded.error}</p>
          <button type="button" className="btn secondary" onClick={loaded.reload}>
            再読み込み
          </button>
        </div>
      )}

      {loaded.data == null && loaded.status === "loading" && <p className="status-line">読み込み中…</p>}

      {loaded.status === "ready" && (
        <>
          <article className="previous-card">
            <h2 className="card-kicker">前回</h2>
            {previous.length === 0 ? (
              <p className="empty-inline">まだ記録がありません</p>
            ) : (
              <>
                <p className="prev-date">{formatMonthDay(previous[0].date)}</p>
                <ul className="session-rows">
                  {previous.map((log) => (
                    <li key={log.id} className="session-row">
                      <span>
                        {formatWeight(log.weightKg)} <small>kg</small>
                      </span>
                      <span>
                        {log.reps} <small>回</small>
                      </span>
                      <span>
                        {log.sets} <small>セット</small>
                      </span>
                      <span className="difficulty-chip">{DIFFICULTY_LABELS[log.difficulty]}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </article>

          <form className="today-card" onSubmit={(event) => void onSave(event)}>
            <h2 className="card-kicker">{dateLabel}</h2>
            {todayLogs.length > 0 && (
              <>
                <ul className="session-rows today-saved">
                  {todayLogs.map((log) => (
                    <li key={log.id} className="session-row">
                      <span>
                        {formatWeight(log.weightKg)} <small>kg</small>
                      </span>
                      <span>
                        {log.reps} <small>回</small>
                      </span>
                      <span>
                        {log.sets} <small>セット</small>
                      </span>
                      <span className="difficulty-chip">{DIFFICULTY_LABELS[log.difficulty]}</span>
                    </li>
                  ))}
                </ul>
                <p className="today-note">{dateLabel}の記録は残したまま、保存でもう1行追加します。</p>
              </>
            )}
            {draft && (
              <>
                <div className="field-row">
                  <label htmlFor="weight">重量</label>
                  <input
                    id="weight"
                    ref={weightRef}
                    inputMode="decimal"
                    autoComplete="off"
                    value={draft.weight}
                    onChange={(event) => update({ weight: event.target.value })}
                  />
                  <span className="unit">kg</span>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="重量を編集"
                    onClick={() => weightRef.current?.focus()}
                  >
                    <Icon>
                      <PencilIcon />
                    </Icon>
                  </button>
                </div>
                <div className="field-row">
                  <label htmlFor="reps">回数</label>
                  <input
                    id="reps"
                    ref={repsRef}
                    inputMode="numeric"
                    autoComplete="off"
                    value={draft.reps}
                    onChange={(event) => update({ reps: event.target.value })}
                  />
                  <span className="unit">回</span>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="回数を編集"
                    onClick={() => repsRef.current?.focus()}
                  >
                    <Icon>
                      <PencilIcon />
                    </Icon>
                  </button>
                </div>
                <div className="field-row">
                  <label htmlFor="sets">セット</label>
                  <input
                    id="sets"
                    ref={setsRef}
                    inputMode="numeric"
                    autoComplete="off"
                    value={draft.sets}
                    onChange={(event) => update({ sets: event.target.value })}
                  />
                  <span className="unit">セット</span>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="セットを編集"
                    onClick={() => setsRef.current?.focus()}
                  >
                    <Icon>
                      <PencilIcon />
                    </Icon>
                  </button>
                </div>
                <div className="difficulty-row">
                  <span id="difficulty-label">きつさ</span>
                  <DifficultyFaces value={draft.difficulty} onChange={(difficulty) => update({ difficulty })} />
                </div>
                <p className="difficulty-caption">
                  {draft.difficulty ? DIFFICULTY_LABELS[draft.difficulty] : "きつさを選択"}
                </p>
              </>
            )}
            <button type="submit" className="btn primary save-btn" disabled={saving || !draft}>
              <Icon>
                <SaveIcon />
              </Icon>
              {saving ? "保存しています…" : "保存"}
            </button>
            {error && <p className="form-error">{error}</p>}
          </form>

          <button type="button" className="skip-btn" onClick={leave}>
            スキップ
            <Icon>
              <ChevronDownIcon />
            </Icon>
          </button>
        </>
      )}

      {confirmDiscard && (
        <Modal
          titleId="discard-title"
          title="変更を破棄しますか？"
          body="入力した内容は保存されません。"
          cancelLabel="戻って編集"
          confirmLabel="破棄する"
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={back}
        />
      )}
    </section>
  );
}
