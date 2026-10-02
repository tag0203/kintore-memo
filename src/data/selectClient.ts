import type { WorkoutLogClient } from "./client";
import { createBrowserClient } from "./browserClient";
import { createHttpWorkoutClient } from "./httpClient";

/**
 * Cognito ログイン済みで API ベース URL があるときだけ HTTP クライアント。
 * どちらかが無いときはインメモリのモック（ローカル UI を止めない）。
 */
export function selectWorkoutClient(options: {
  apiBaseUrl: string | null;
  signedIn: boolean;
  getIdToken: () => Promise<string>;
  now?: Date;
}): WorkoutLogClient {
  const apiBaseUrl = options.apiBaseUrl?.trim() ?? "";
  if (options.signedIn && apiBaseUrl) {
    return createHttpWorkoutClient({
      apiBaseUrl,
      getIdToken: options.getIdToken,
      now: options.now,
    });
  }
  return createBrowserClient(options.now);
}
