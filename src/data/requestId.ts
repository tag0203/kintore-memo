/**
 * 画面に出してよい相関 ID。
 * Lambda は UUID。API Gateway HTTP API は ':' を含まない短い base64（末尾の = を含むことがある）。
 * ARN は ':' を含むので一致しない。12 桁のアカウント ID も捨てる。
 */

const LAMBDA_REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const APIGW_REQUEST_ID = /^[A-Za-z0-9+_=-]{8,128}$/;

export function readRequestId(value: unknown): string {
  if (typeof value !== "string") return "";
  const id = value.trim();
  if (LAMBDA_REQUEST_ID.test(id)) return id;
  if (!APIGW_REQUEST_ID.test(id)) return "";
  if (/\d{12}/.test(id) || !/[A-Za-z]/.test(id)) return "";
  return id;
}

export function requestIdFromPayload(payload: unknown): string {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return "";
  return readRequestId((payload as { requestId?: unknown }).requestId);
}
