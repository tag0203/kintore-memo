/** A stalled DayPlan PUT must not keep the user signed in. A fast save is still awaited. */
export const SIGN_OUT_HOOK_TIMEOUT_MS = 3_000;

/**
 * Run session hooks (DayPlan flush) before tokens are cleared.
 * A failing or stalled hook must not skip sign-out. The in-flight request is left running.
 */
export async function runBeforeSignOut(
  hooks: ReadonlyArray<() => Promise<void>>,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? SIGN_OUT_HOOK_TIMEOUT_MS;
  for (const hook of [...hooks]) {
    await runHookWithin(hook, timeoutMs);
  }
}

async function runHookWithin(hook: () => Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  const work = Promise.resolve()
    .then(hook)
    .then(
      () => undefined,
      () => undefined,
    );
  try {
    await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
