import { DayPlanRequestError, type DayPlanInput } from "./dayPlanClient";

export const DAY_PLAN_SAVE_ERROR = "保存できませんでした";

export const DAY_PLAN_SAVE_WAIT_MS = 400;

interface DayPlanSaverListeners {
  onError?: (message: string) => void;
  onSaved?: () => void;
  /** 保存の通信が始まった・終わった。true のあいだは破棄できない。 */
  onSending?: (sending: boolean) => void;
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
  /** 日付の確認ダイアログ中。タイマーは止めるが、flush と送信中のリクエストは止めない。 */
  let paused = false;
  let latest: DayPlanInput | null = null;
  let savedKey = "";
  let inflight = 0;
  let chain: Promise<boolean> = Promise.resolve(true);

  function setSending(next: number) {
    inflight = next;
    listeners.onSending?.(inflight > 0);
  }

  function isCurrentSaved(): boolean {
    // 送信中は、画面が戻っていても保存済みにしない。成功結果がまだ反映されていない。
    if (inflight > 0) return false;
    return latest == null || fingerprint(latest) === savedKey;
  }

  /** false: 未保存のスナップショットを書けなかった。true: この送信は受け付けた（新しい編集が残ることもある）。 */
  async function send(): Promise<boolean> {
    const input = latest;
    if (!input || fingerprint(input) === savedKey) return true;
    const key = fingerprint(input);
    if (!allowWrite()) return false;
    setSending(inflight + 1);
    try {
      await save(input);
      // サーバーに載ったスナップショットを記録する。画面が X に戻っていても、Y の成功を捨てると X を保存済みと誤る。
      savedKey = key;
      if (latest && fingerprint(latest) === key) listeners.onSaved?.();
      return true;
    } catch (error) {
      if (latest && fingerprint(latest) === key) {
        const code = error instanceof DayPlanRequestError ? error.code : "error";
        console.error("day plan save failed", code);
        listeners.onError?.(DAY_PLAN_SAVE_ERROR);
      }
      return false;
    } finally {
      setSending(inflight - 1);
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

  function arm(): void {
    if (paused || timer) return;
    if (!latest || fingerprint(latest) === savedKey) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, waitMs);
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
      if (fingerprint(latest) === savedKey) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        return;
      }
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      arm();
    },
    /** 確認ダイアログのあいだ、まだ送っていない自動保存を止める。 */
    pause() {
      paused = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    /** キャンセルしたあと、残っている変更の自動保存を再開する。 */
    resume() {
      paused = false;
      arm();
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
    /** まだサーバーと一致していない。送信中も未保存。 */
    dirty() {
      return inflight > 0 || (latest != null && fingerprint(latest) !== savedKey);
    },
    /** 保存の通信中。このあいだ破棄しても、送信中のリクエストは前の日付へ届く。 */
    saving() {
      return inflight > 0;
    },
    /** 未送信の変更を捨てる。送らずに日付を変えるとき。 */
    dropPending() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      latest = null;
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
