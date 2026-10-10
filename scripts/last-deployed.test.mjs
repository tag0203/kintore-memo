import { describe, expect, it } from "vitest";
import {
  fetchLastDeployedSha,
  recordSuccessfulDevDeployment,
  selectLastSuccessfulDeploymentSha,
} from "./last-deployed.mjs";

const APP = "a".repeat(40);
const DOCS = "b".repeat(40);
const OLDER = "c".repeat(40);
const TOKEN = "ghs_test_token_not_for_logs";

describe("selectLastSuccessfulDeploymentSha", () => {
  it("uses the newest success and skips failures, in-progress, and inactive without success", () => {
    expect(
      selectLastSuccessfulDeploymentSha([
        { sha: APP, statuses: ["in_progress"] },
        { sha: "d".repeat(40), statuses: ["failure", "success"] },
        { sha: DOCS, statuses: ["inactive", "success"] },
        { sha: OLDER, statuses: ["success"] },
      ]),
    ).toBe(DOCS);
    expect(selectLastSuccessfulDeploymentSha([{ sha: APP, statuses: ["success"] }])).toBe(APP);
    expect(selectLastSuccessfulDeploymentSha([{ sha: APP, statuses: ["inactive"] }])).toBeNull();
    expect(selectLastSuccessfulDeploymentSha([])).toBeNull();
    expect(selectLastSuccessfulDeploymentSha([{ sha: "not-a-sha", statuses: ["success"] }])).toBeNull();
  });
});

/**
 * @param {{ method?: string, url: string, status?: number, body: unknown }[]} routes
 */
function mockFetch(routes) {
  /** @type {{ url: string, init: { method?: string, body?: string, headers?: Record<string, string> } }[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url: String(url), init: { method, body: init.body ? String(init.body) : undefined, headers: init.headers } });
    const match = routes.find((route) => route.url === String(url) && (route.method ?? "GET") === method);
    if (!match) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: (match.status ?? 200) < 400, status: match.status ?? 200, json: async () => match.body };
  };
  return { fetchImpl, calls };
}

describe("fetchLastDeployedSha", () => {
  it("returns the newest successful dev SHA and ignores a foreign statuses URL", async () => {
    const path = "tag0203/kintore-memo";
    const successUrl = `https://api.github.com/repos/${path}/deployments/7/statuses`;
    const { fetchImpl, calls } = mockFetch([
      {
        url: `https://api.github.com/repos/${path}/deployments?environment=dev&per_page=20`,
        body: [
          { sha: APP, statuses_url: "https://evil.example/statuses" },
          { sha: DOCS, statuses_url: successUrl },
        ],
      },
      { url: successUrl, body: [{ state: "success" }] },
    ]);
    await expect(fetchLastDeployedSha({ token: TOKEN, repository: path, fetchImpl })).resolves.toBe(DOCS);
    expect(calls.map((call) => call.url)).toEqual([
      `https://api.github.com/repos/${path}/deployments?environment=dev&per_page=20`,
      successUrl,
    ]);
    expect(calls[0].init.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("fails closed on HTTP errors without echoing the token", async () => {
    const { fetchImpl } = mockFetch([
      {
        url: "https://api.github.com/repos/tag0203/kintore-memo/deployments?environment=dev&per_page=20",
        status: 401,
        body: { message: TOKEN },
      },
    ]);
    await expect(
      fetchLastDeployedSha({ token: TOKEN, repository: "tag0203/kintore-memo", fetchImpl }),
    ).rejects.toThrow("list deployments failed: HTTP 401");
  });
});

describe("recordSuccessfulDevDeployment", () => {
  it("creates a dev deployment for the SHA and marks it successful", async () => {
    const path = "tag0203/kintore-memo";
    const { fetchImpl, calls } = mockFetch([
      {
        method: "POST",
        url: `https://api.github.com/repos/${path}/deployments`,
        status: 201,
        body: { id: 42, sha: APP },
      },
      {
        method: "POST",
        url: `https://api.github.com/repos/${path}/deployments/42/statuses`,
        status: 201,
        body: { state: "success" },
      },
    ]);
    await expect(
      recordSuccessfulDevDeployment({ token: TOKEN, repository: path, sha: APP, fetchImpl }),
    ).resolves.toEqual({ id: 42, sha: APP });
    expect(JSON.parse(calls[0].init.body ?? "")).toEqual({
      ref: APP,
      environment: "dev",
      auto_merge: false,
      required_contexts: [],
      transient_environment: false,
      production_environment: false,
      description: "kintore-memo dev",
    });
    expect(JSON.parse(calls[1].init.body ?? "")).toMatchObject({
      state: "success",
      environment: "dev",
      auto_inactive: true,
    });
    expect(calls[0].init.body).not.toContain(TOKEN);
  });
});
