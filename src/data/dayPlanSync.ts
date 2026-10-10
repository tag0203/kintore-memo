import { DayPlanRequestError, type DayPlanInput } from "./dayPlanClient";

export const DAY_PLAN_SAVE_WAIT_MS = 400;

interface DayPlanSaverListeners {
  onError?: (message: string) => void;
  onSaved?: () => void;
}

function fingerprint(input: DayPlanInput): string {
  return JSON.stringify([input.date, input.memo, input.finished, input.exercises]);
}

function snapshot(input: DayPlanInput): DayPlanInput {
  return {
    date: input.date,
    memo: input.memo,
    finished: input.finished,
    exercises: [...input.exercises],
  };
}

/**
 * Debounced, ordered saves. A newer snapshot replaces one that has not been sent.
 * Call flush() on pagehide so a reload does not drop the last edit.
 * flush() resolves false when the latest snapshot was not stored. The caller must
 * not markSaved() over it, or the unsaved edit is gone.
 */
export function createDayPlanSaver(
  save: (input: DayPlanInput) => Promise<void>,
  options: { waitMs?: number; allowWrite?: () => boolean } = {},
) {
  const waitMs = options.waitMs ?? DAY_PLAN_SAVE_WAIT_MS;
  const allowWrite = options.allowWrite ?? (() => true);
  let listeners: DayPlanSaverListeners = {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: DayPlanInput | null = null;
  let savedKey = "";
  /** 同じ内容を再送しても成功しない。date_window だけ。オフラインなどは false。 */
  let rejected = false;
  let chain: Promise<boolean> = Promise.resolve(true);

  function isDateWindow(error: unknown): boolean {
    return error instanceof DayPlanRequestError && error.code === "date_window";
  }

  function isCurrentSaved(): boolean {
    return latest == null || fingerprint(latest) === savedKey;
  }

  /** false: 未保存のスナップショットを書けなかった。true: この送信は受け付けた（新しい編集が残ることもある）。 */
  async function send(): Promise<boolean> {
    const input = latest;
    if (!input || fingerprint(input) === savedKey) return true;
    const key = fingerprint(input);
    if (!allowWrite()) return false;
    try {
      await save(input);
      if (latest && fingerprint(latest) === key) {
        savedKey = key;
        rejected = false;
        listeners.onSaved?.();
      }
      return true;
    } catch (error) {
      if (latest && fingerprint(latest) === key) {
        rejected = isDateWindow(error);
        const message = error instanceof Error ? error.message : "メニューを保存できませんでした";
        listeners.onError?.(message);
      }
      return false;
    }
  }

  async function drain(): Promise<boolean> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (isCurrentSaved()) return true;
      const ok = await send();
      if (!ok) return false;
    }
    return isCurrentSaved();
  }

  /** 最新のスナップショットが保存できたときだけ true。失敗しても latest は残す。 */
  function flush(): Promise<boolean> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const run = chain.then(drain);
    chain = run;
    return run;
  }

  return {
    schedule(input: DayPlanInput) {
      latest = snapshot(input);
      rejected = false;
      if (fingerprint(latest) === savedKey) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, waitMs);
    },
    /** The loaded plan is already on the server. Do not write it back. */
    markSaved(input: DayPlanInput) {
      latest = snapshot(input);
      savedKey = fingerprint(latest);
      rejected = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    flush,
    /** 直前の flush が date_window で失敗し、そのスナップショットがまだ残っている。 */
    unsaveable() {
      return rejected && latest != null && fingerprint(latest) !== savedKey;
    },
    /** 保存できないスナップショットを捨て、再送しない。 */
    dropPending() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      latest = null;
      rejected = false;
    },
    /** Drop a debounce timer. Does not abort a save that flush() already started. */
    cancel() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    setListeners(next: DayPlanSaverListeners) {
      listeners = next;
    },
  };
}
