/**
 * Minimal Lambda handler for the AWS skeleton (#8).
 * Real Notion / DynamoDB routes land in #10 and #6.
 *
 * Public:  GET /api/health
 * Auth:    other /api/* (JWT via API Gateway; stub returns 501)
 */

const json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  },
  body: JSON.stringify(body),
});

export const handler = async (event) => {
  const method = event.requestContext?.http?.method ?? event.httpMethod ?? "GET";
  const path = event.rawPath ?? event.path ?? "/";

  if (method === "GET" && path === "/api/health") {
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
