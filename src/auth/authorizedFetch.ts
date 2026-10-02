/**
 * API Gateway へ JWT 付きで呼ぶ薄いラッパ。
 * WorkoutLogClient の本番実装（#12）がこれを使う想定。
 * IdToken を Authorization: Bearer に載せる（HTTP API JWT Authorizer の audience = App Client）。
 */
export async function authorizedFetch(
  input: string,
  init: RequestInit | undefined,
  getIdToken: () => Promise<string>,
): Promise<Response> {
  const token = await getIdToken();
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init?.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(input, { ...init, headers });
}

/** apiBaseUrl + path を結合する（path は / 始まり） */
export function apiUrl(apiBaseUrl: string, path: string): string {
  const base = apiBaseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}
