/**
 * Minimal Lambda handler for the AWS skeleton (#8).
 * Real Notion / DynamoDB routes land in #10 and #6.
 * Table items are built by dynamodb.mjs (docs/dynamodb.md). This handler does not read the table.
 *
 * Public:  GET /api/health
 * Auth:    other /api/* (JWT via API Gateway; stub returns 501)
 *
 * HTTP API payload v2 puts the stage name on rawPath (e.g. /dev/api/health).
 * Prefer routeKey, which is stage-independent ("GET /api/health").
 */

const json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  },
  body: JSON.stringify(body),
});

/** Strip named-stage prefix from HTTP API v2 rawPath when present. */
export function resolvePath(event) {
  const rawPath = event.rawPath ?? event.path ?? "/";
  const stage = event.requestContext?.stage;
  if (stage && stage !== "$default" && rawPath.startsWith(`/${stage}/`)) {
    return rawPath.slice(stage.length + 1) || "/";
  }
  return rawPath;
}

export function isHealthGet(event) {
  if (event.routeKey === "GET /api/health") return true;
  const method = event.requestContext?.http?.method ?? event.httpMethod ?? "GET";
  return method === "GET" && resolvePath(event) === "/api/health";
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method ?? event.httpMethod ?? "GET";
  const path = resolvePath(event);

  if (isHealthGet(event)) {
    return json(200, {
      ok: true,
      service: "kintore-memo",
      stage: "skeleton",
      notionConfigured: false,
      tableName: process.env.TABLE_NAME ?? null,
    });
  }

  return json(501, {
    error: "not_implemented",
    message: "API routes beyond /api/health are added in later issues (#9, #10).",
    path,
    method,
  });
};
