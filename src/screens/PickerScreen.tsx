import { useState, type FormEvent } from "react";
import { BackIcon, ChevronRightIcon, DumbbellIcon, Icon, SearchIcon } from "../components/icons";
import { useClient } from "../clientContext";
import { DAY_PLAN_TOO_MANY_EXERCISES } from "../data/dayPlanClient";
import { useLoad } from "../hooks/useLoad";
import type { Route } from "../route";
import { useSession } from "../session";

export function PickerScreen({
  navigate,
  back,
}: {
  navigate: (route: Route) => void;
  back: () => void;
}) {
  const client = useClient();
  const session = useSession();
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [showAllRecent, setShowAllRecent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loaded = useLoad(async () => {
    const [exercises, recent] = await Promise.all([client.listExercises(), client.listRecentExercises()]);
    return { exercises, recent };
  }, [client]);

  const normalized = query.trim();
  const exercises = loaded.data?.exercises ?? [];
  const recent = loaded.data?.recent ?? [];
  const visibleRecent = showAllRecent ? recent : recent.slice(0, 3);
  const filtered = normalized
    ? exercises.filter((exercise) => exercise.name.includes(normalized))
    : exercises;

  async function choose(name: string) {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.touchExercise(trimmed, new Date().toISOString());
      const added = session.addExercise(trimmed);
      if (added === "too_many") {
        setError(DAY_PLAN_TOO_MANY_EXERCISES);
        setBusy(false);
        return;
      }
      navigate({ screen: "record", exercise: trimmed });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "追加できませんでした");
      setBusy(false);
    }
  }

  function onAdd(event: FormEvent) {
    event.preventDefault();
    void choose(draft);
  }

  return (
    <section className="screen picker">
      <header className="nav">
        <button type="button" className="back-btn" onClick={back} aria-label="戻る">
          <Icon>
            <BackIcon />
          </Icon>
        </button>
        <h1>種目を追加</h1>
        <span />
      </header>

      <label className="search">
        <Icon>
          <SearchIcon />
        </Icon>
        <input
          value={query}
          placeholder="検索"
          aria-label="種目を検索"
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      {loaded.status === "error" && (
        <div className="status-line">
          <p className="text-error">{loaded.error}</p>
          <button type="button" className="btn secondary" onClick={loaded.reload}>
            再読み込み
          </button>
        </div>
      )}

      {loaded.data == null && loaded.status === "loading" && <p className="status-line">読み込み中…</p>}

      {loaded.data && !normalized && recent.length > 0 && (
        <div className="recent-block">
          <div className="section-head">
            <h2>最近</h2>
            {recent.length > 3 && (
              <button type="button" className="link-btn" onClick={() => setShowAllRecent((value) => !value)}>
                {showAllRecent ? "閉じる" : "すべて表示"}
                {!showAllRecent && <span aria-hidden="true"> ›</span>}
              </button>
            )}
          </div>
          <div className="chip-row">
            {visibleRecent.map((exercise) => (
              <button key={exercise.name} type="button" className="chip" onClick={() => void choose(exercise.name)}>
                {exercise.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {loaded.data && (
        <div className="catalog">
          <h2 className="section-label">{normalized ? "検索結果" : "すべて"}</h2>
          {filtered.length === 0 ? (
            <p className="empty">「{normalized}」に一致する種目がありません。下の欄から追加できます。</p>
          ) : (
            <ul className="exercise-list">
              {filtered.map((exercise) => {
                const inPlan = session.exercises.includes(exercise.name);
                return (
                  <li key={exercise.name}>
                    <button
                      type="button"
                      className={inPlan ? "exercise-row is-in-plan" : "exercise-row"}
                      onClick={() => void choose(exercise.name)}
                    >
                      <Icon>
                        <DumbbellIcon />
                      </Icon>
                      <span className="row-label">{exercise.name}</span>
                      <Icon>
                        <ChevronRightIcon />
                      </Icon>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <form className="picker-add" onSubmit={onAdd}>
        {error && <p className="form-error">{error}</p>}
        <div className="picker-add-row">
          <input
            className="text-input"
            value={draft}
            placeholder="新しい種目名"
            aria-label="新しい種目名"
            maxLength={40}
            autoComplete="off"
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" className="btn primary" disabled={!draft.trim() || busy}>
            追加
          </button>
        </div>
      </form>
    </section>
  );
}
