/**
 * Run session hooks (DayPlan flush) before tokens are cleared.
 * A failing hook must not skip sign-out.
 */
export async function runBeforeSignOut(hooks: ReadonlyArray<() => Promise<void>>): Promise<void> {
  for (const hook of [...hooks]) {
    try {
      await hook();
    } catch {
      // 保存に失敗してもログアウトは続ける。
    }
  }
}
