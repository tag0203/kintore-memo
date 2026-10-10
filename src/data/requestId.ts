/**
 * 画面に出してよい相関 ID。
 * Lambda は UUID。API Gateway HTTP API は標準 base64（末尾の = だけ）。
 * '_' と '-' と ':' は許さないので、トークン接頭辞・ARN・適当な文字列は一致しない。
 * 32 文字の Notion ID と 12 桁のアカウント ID も捨てる。
 */

const LAMBDA_REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const APIGW_REQUEST_ID = /^[A-Za-z0-9+/]{8,128}={0,2}$/;

const NOTION_ID = /^[0-9a-f]{32}$/i;

function looksLikeSecret(id: string): boolean {
  const lower = id.toLowerCase();
  return lower.includes("ntn_") || lower.includes("secret_") || NOTION_ID.test(id);
}

export function readRequestId(value: unknown): string {
  if (typeof value !== "string") return "";
  const id = value.trim();
  if (looksLikeSecret(id)) return "";
  if (LAMBDA_REQUEST_ID.test(id)) return id;
  if (!APIGW_REQUEST_ID.test(id)) return "";
  if (/\d{12}/.test(id) || !/[A-Za-z]/.test(id)) return "";
  return id;
}

export function requestIdFromPayload(payload: unknown): string {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return "";
  return readRequestId((payload as { requestId?: unknown }).requestId);
}
