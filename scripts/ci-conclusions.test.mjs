import { describe, expect, it } from "vitest";
import { CI_WORKFLOW_ID } from "./ci-workflow-run.mjs";
import { fetchPushCiConclusions, selectPushCiConclusion } from "./ci-conclusions.mjs";

const SHA = "a".repeat(40);
const TOKEN = "ghs_test_token_not_for_logs";

/** @param {number} id @param {Record<string, unknown>} [overrides] */
function run(id, overrides = {}) {
  return {
    id,
    name: "CI",
    head_branch: "main",
    head_sha: SHA,
    path: ".github/workflows/ci.yml",
    event: "push",
    status: "completed",
    conclusion: "success",
    workflow_id: CI_WORKFLOW_ID,
    ...overrides,
  };
}

describe("selectPushCiConclusion", () => {
  it("uses the latest completed push of this CI workflow", () => {
    expect(
      selectPushCiConclusion(
        [
          run(1, { conclusion: "success" }),
          run(2, { conclusion: "failure" }),
          run(9, { event: "pull_request", conclusion: "success", id: 9 }),
          run(8, { workflow_id: 1, conclusion: "success", id: 8 }),
          run(7, { name: "test", conclusion: "success", id: 7 }),
          run(6, { head_branch: "other", conclusion: "success", id: 6 }),
          run(5, { path: ".github/workflows/test.yml", conclusion: "success", id: 5 }),
        ],
        SHA,
      ),
    ).toBe("failure");
    expect(selectPushCiConclusion([run(3, { path: ".github/workflows/ci.yml@main" })], SHA)).toBe("success");
    expect(selectPushCiConclusion([run(4, { status: "in_progress", conclusion: null })], SHA)).toBe("pending");
    expect(selectPushCiConclusion([run(4, { conclusion: "cancelled" })], SHA)).toBe("failure");
    expect(selectPushCiConclusion([], SHA)).toBe("unknown");
    expect(selectPushCiConclusion([run(4, { status: "completed", conclusion: null })], SHA)).toBe("unknown");
  });
});

describe("fetchPushCiConclusions", () => {
  it("records success and treats an HTTP error as unknown without echoing the token", async () => {
    const failed = "b".repeat(40);
    const path = "tag0203/kintore-memo";
    /** @type {{ url: string }[]} */
    const calls = [];
    /** @type {typeof fetch} */
    const fetchImpl = async (url) => {
      calls.push({ url: String(url) });
      if (String(url).includes(failed)) {
        return { ok: false, status: 401, json: async () => ({ message: TOKEN }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ workflow_runs: [run(11)] }),
      };
    };
    await expect(
      fetchPushCiConclusions({ token: TOKEN, repository: path, shas: [SHA, failed], fetchImpl }),
    ).resolves.toEqual({ [SHA]: "success", [failed]: "unknown" });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain(`/actions/workflows/${CI_WORKFLOW_ID}/runs?head_sha=${SHA}`);
    expect(JSON.stringify(calls)).not.toContain(TOKEN);
  });
});
