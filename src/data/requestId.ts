/**
 * 画面に出してよい相関 ID。API Gateway HTTP API の標準 base64 だけ。
 * UUID は Lambda のリクエスト ID でも Notion の ID でもあるので出さない。
 * トークン接頭辞、32 文字の Notion ID、12 桁のアカウント ID、ARN も捨てる。
 */

const APIGW_REQUEST_ID = /^[A-Za-z0-9+/]{8,128}={0,2}$/;

const NOTION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOTION_ID = /^[0-9a-f]{32}$/i;

function looksLikeSecret(id: string): boolean {
  const lower = id.toLowerCase();
  return lower.includes("ntn_") || lower.includes("secret_") || NOTION_ID.test(id) || NOTION_UUID.test(id);
}

export function readRequestId(value: unknown): string {
  if (typeof value !== "string") return "";
  const id = value.trim();
  if (looksLikeSecret(id)) return "";
  if (!APIGW_REQUEST_ID.test(id)) return "";
  if (/\d{12}/.test(id) || !/[A-Za-z]/.test(id)) return "";
  return id;
}

export function requestIdFromPayload(payload: unknown): string {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return "";
  return readRequestId((payload as { requestId?: unknown }).requestId);
}
