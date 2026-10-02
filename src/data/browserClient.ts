import type { WorkoutLogClient } from "./client";
import { createMockClient } from "./mockClient";
import { createSeed } from "./seed";

let singleton: WorkoutLogClient | null = null;

/**
 * API ベース URL が無いときのブラウザ用クライアント。
 * このタブのメモリだけを使い、再読み込みで初期データに戻る。
 * サーバの資格情報はここから参照しない。
 */
export function createBrowserClient(now = new Date()): WorkoutLogClient {
  singleton ??= createMockClient(createSeed(now));
  return singleton;
}
