import { DIFFICULTY_LABELS, DIFFICULTIES, type Difficulty } from "../domain";

function Face({ level }: { level: Difficulty }) {
  const mouth = {
    1: "M7.2 14.2c1.2 2.2 2.7 3.2 4.8 3.2s3.6-1 4.8-3.2",
    2: "M8 15c.9 1.4 2.1 2.1 4 2.1s3.1-.7 4-2.1",
    3: "M8.2 16.2h7.6",
    4: "M8 17.2c.9-1.4 2.1-2.1 4-2.1s3.1.7 4 2.1",
    5: "M7.2 18c1.2-2.2 2.7-3.2 4.8-3.2s3.6 1 4.8 3.2",
  }[level];

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {level >= 4 && (
        <>
          <path d={level === 5 ? "M7 8.2 10 7" : "M7.2 8h3"} />
          <path d={level === 5 ? "M17 8.2 14 7" : "M13.8 8h3"} />
        </>
      )}
      <circle className="fill" cx="9" cy="11.2" r="0.9" />
      <circle className="fill" cx="15" cy="11.2" r="0.9" />
      <path d={mouth} />
    </svg>
  );
}

export function Stars({ value }: { value: number }) {
  return (
    <span className="stars" aria-label={`きつさ ${value} / 5`}>
      {DIFFICULTIES.map((star) => (
        <svg key={star} viewBox="0 0 20 20" className={star <= value ? "is-on" : ""} aria-hidden="true">
          <path d="M10 1.8 12.4 7l5.6.5-4.2 3.7 1.3 5.5L10 13.8 4.9 16.7 6.2 11.2 2 7.5 7.6 7Z" />
        </svg>
      ))}
    </span>
  );
}

export function DifficultyFaces({
  value,
  onChange,
}: {
  value: Difficulty | null;
  onChange: (value: Difficulty) => void;
}) {
  return (
    <div className="faces" role="group" aria-label="きつさ">
      {DIFFICULTIES.map((level) => {
        const selected = value === level;
        return (
          <button
            key={level}
            type="button"
            className="face-btn"
            aria-pressed={selected}
            aria-label={DIFFICULTY_LABELS[level]}
            onClick={() => onChange(level)}
          >
            <Face level={level} />
          </button>
        );
      })}
    </div>
  );
}
