/**
 * Rate-limit boundary in front of the Notion client.
 *
 * Session bootstrap and the individual GETs share one recent-log window.
 * A second call inside the TTL does not call Notion again.
 * Notion is called again after a save, which drops the window and that exercise's keys.
 * Screen navigation is still expected to use the client cache (#12); this is not a substitute.
 */
import { ItemValidationError } from "./notionCache.mjs";

function sortDesc(logs) {
  return [...logs].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return 0;
  });
}

export function summariesFromLogs(logs) {
  const seen = new Set();
  const recent = [];
  for (const log of sortDesc(logs)) {
    if (seen.has(log.exercise)) continue;
    seen.add(log.exercise);
    recent.push({ name: log.exercise, lastPickedAt: log.createdAt });
  }
  return recent;
}

export function previousFromWindow(logs, exercise, before) {
  let best = null;
  for (const log of logs) {
    if (log.exercise !== exercise || log.date >= before) continue;
    if (!best || log.date > best.date || (log.date === best.date && log.createdAt > best.createdAt)) {
      best = log;
    }
  }
  return best;
}

function oldestDate(logs) {
  let oldest = null;
  for (const log of logs) {
    if (!oldest || log.date < oldest) oldest = log.date;
  }
  return oldest;
}

export function todayFromWindow(logs, exercise, date) {
  let best = null;
  for (const log of logs) {
    if (log.exercise !== exercise || log.date !== date) continue;
    if (!best || log.createdAt > best.createdAt) best = log;
  }
  return best;
}

/** `{ known: true, log }` when the window can prove the answer, including an empty one. */
export function previousInWindow(window, exercise, before) {
  const log = previousFromWindow(window.logs, exercise, before);
  if (log) return { known: true, log };
  if (window.complete) return { known: true, log: null };
  return { known: false };
}

export function todayInWindow(window, exercise, date) {
  const log = todayFromWindow(window.logs, exercise, date);
  if (log) return { known: true, log };
  if (window.complete) return { known: true, log: null };
  const oldest = oldestDate(window.logs);
  if (oldest && date > oldest) return { known: true, log: null };
  return { known: false };
}

function createJsonCache(store) {
  const inflight = new Map();

  return {
    getOrLoad(segments, loader) {
      const key = segments.join("\0");
      const existing = inflight.get(key);
      if (existing) return existing;
      const next = (async () => {
        const raw = await store.get(segments);
        if (raw != null) return JSON.parse(raw).v;
        const value = await loader();
        try {
          await store.put(segments, JSON.stringify({ v: value }));
        } catch (error) {
          if (!(error instanceof ItemValidationError)) {
            const name = error instanceof Error ? error.name : "Error";
            console.warn(`[notion-cache] ${name}`);
          }
        }
        return value;
      })();
      inflight.set(key, next);
      // The caller awaits `next`. This side chain only clears the slot, so its
      // rejection must not surface as a second unhandled error.
      next.finally(() => {
        inflight.delete(key);
      }).catch(() => {});
      return next;
    },
    delete(segments) {
      return store.delete(segments);
    },
    deleteWhere(predicate) {
      return store.deleteWhere(predicate);
    },
  };
}

/**
 * @param {{ client: { listExercises: Function, loadRecentWindow: Function, getPreviousLog: Function, getLogOnDate: Function, createLog: Function }, cache: { get: Function, put: Function, delete: Function, deleteWhere: Function } }} deps
 */
export function createNotionService(deps) {
  const cache = createJsonCache(deps.cache);
  const client = deps.client;

  function recentWindow() {
    return cache.getOrLoad(["exercises", "recent"], () => client.loadRecentWindow());
  }

  async function listExercises() {
    return cache.getOrLoad(["exercises"], () => client.listExercises());
  }

  async function listRecentExercises() {
    const window = await recentWindow();
    return summariesFromLogs(window.logs);
  }

  async function getPreviousLog(exercise, before) {
    const window = await recentWindow();
    const resolved = previousInWindow(window, exercise, before);
    if (resolved.known) return resolved.log;
    return cache.getOrLoad(["logs", "previous", exercise, before], () => client.getPreviousLog(exercise, before));
  }

  async function getLogOnDate(exercise, date) {
    const window = await recentWindow();
    const resolved = todayInWindow(window, exercise, date);
    if (resolved.known) return resolved.log;
    return cache.getOrLoad(["logs", "today", exercise, date], () => client.getLogOnDate(exercise, date));
  }

  async function bootstrap(date, exercises) {
    const [catalog, window] = await Promise.all([listExercises(), recentWindow()]);
    const names = exercises.length > 0 ? exercises : summariesFromLogs(window.logs).map((item) => item.name);
    /** @type {Record<string, { previous: unknown, today: unknown }>} */
    const logs = {};
    for (const name of names) {
      const previous = previousInWindow(window, name, date);
      const today = todayInWindow(window, name, date);
      logs[name] = {
        previous: previous.known
          ? previous.log
          : await cache.getOrLoad(["logs", "previous", name, date], () => client.getPreviousLog(name, date)),
        today: today.known
          ? today.log
          : await cache.getOrLoad(["logs", "today", name, date], () => client.getLogOnDate(name, date)),
      };
    }
    return {
      date,
      exercises: catalog,
      recent: summariesFromLogs(window.logs),
      logs,
    };
  }

  async function createLog(input) {
    const log = await client.createLog(input);
    await cache.delete(["exercises"]);
    await cache.delete(["exercises", "recent"]);
    await cache.delete(["logs", "today", input.exercise, input.date]);
    const previousPrefix = `logs#previous#${input.exercise}#`;
    await cache.deleteWhere(
      (key) => key === "bootstrap" || key.startsWith("bootstrap#") || key.startsWith(previousPrefix),
    );
    return log;
  }

  return {
    listExercises,
    listRecentExercises,
    getPreviousLog,
    getLogOnDate,
    bootstrap,
    createLog,
  };
}
