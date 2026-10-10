import { describe, expect, it } from "vitest";
import { fetchActionsVariable } from "./actions-variable.mjs";

const TOKEN = "ghs_test_token_not_for_logs";
const ARN = "arn:aws:iam::123456789012:role/kintore-memo-gha-deploy";

/**
 * @param {{ status: number, body?: unknown }} route
 */
function mockFetch(route) {
  /** @type {{ url: string, authorization: string | undefined }[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (url, init = {}) => {
    const headers = init.headers;
    const authorization =
      headers && typeof headers === "object" && "Authorization" in headers
        ? String(headers.Authorization)
        : undefined;
    calls.push({ url: String(url), authorization });
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      json: async () => route.body,
    };
  };
  return { fetchImpl, calls };
}

describe("fetchActionsVariable", () => {
  it("reads a repository variable with Bearer and does not treat 404 as an error", async () => {
    const found = mockFetch({ status: 200, body: { name: "AWS_DEPLOY_ROLE_ARN", value: ARN } });
    await expect(
      fetchActionsVariable({
        token: TOKEN,
        repository: "tag0203/kintore-memo",
        name: "AWS_DEPLOY_ROLE_ARN",
        fetchImpl: found.fetchImpl,
      }),
    ).resolves.toBe(ARN);
    expect(found.calls[0]).toEqual({
      url: "https://api.github.com/repos/tag0203/kintore-memo/actions/variables/AWS_DEPLOY_ROLE_ARN",
      authorization: `Bearer ${TOKEN}`,
    });

    const missing = mockFetch({ status: 404, body: { message: TOKEN, value: ARN } });
    await expect(
      fetchActionsVariable({
        token: TOKEN,
        repository: "tag0203/kintore-memo",
        name: "AWS_DEPLOY_ROLE_ARN",
        fetchImpl: missing.fetchImpl,
      }),
    ).resolves.toBeNull();
  });

  it("fails closed without echoing the token or the response body", async () => {
    const { fetchImpl } = mockFetch({ status: 401, body: { message: TOKEN, value: ARN } });
    await expect(
      fetchActionsVariable({
        token: TOKEN,
        repository: "tag0203/kintore-memo",
        name: "AWS_DEPLOY_ROLE_ARN",
        fetchImpl,
      }),
    ).rejects.toThrow("read actions variable failed: HTTP 401");
    await expect(
      fetchActionsVariable({ token: "", repository: "tag0203/kintore-memo", name: "AWS_DEPLOY_ROLE_ARN", fetchImpl }),
    ).rejects.toThrow("GITHUB_TOKEN is required");
  });
});
