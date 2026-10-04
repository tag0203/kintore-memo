import type { DayPlanInput } from "./dayPlanClient";

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
  let chain: Promise<void> = Promise.resolve();

  async function send() {
    if (!allowWrite()) return;
    const input = latest;
    if (!input) return;
    const key = fingerprint(input);
    if (key === savedKey) return;
    if (!allowWrite()) return;
    try {
      await save(input);
      if (latest && fingerprint(latest) === key) {
        savedKey = key;
        listeners.onSaved?.();
      }
    } catch (error) {
      if (latest && fingerprint(latest) === key) {
        const message = error instanceof Error ? error.message : "メニューを保存できませんでした";
        listeners.onError?.(message);
      }
    }
  }

  function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!latest || fingerprint(latest) === savedKey) return chain;
    chain = chain.then(send);
    return chain;
  }

  return {
    schedule(input: DayPlanInput) {
      latest = snapshot(input);
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
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    flush,
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
