import { describe, expect, it } from "vitest";
import { CI_WORKFLOW_ID, REPOSITORY_ID } from "./ci-workflow-run.mjs";
import {
  chooseDispatchTarget,
  classifyPulls,
  dispatchAfterPullRequestCi,
  mainCiCovers,
  trustedPullRequestCi,
} from "./dependabot-dispatch.mjs";

const MERGE = "a".repeat(40);
const TIP = "b".repeat(40);
const PR_HEAD = "c".repeat(40);
const TOKEN = "ghs_test_token_not_for_logs";
const REPO = "tag0203/kintore-memo";

const trusted = {
  conclusion: "success",
  event: "pull_request",
  name: "CI",
  workflowId: CI_WORKFLOW_ID,
  headSha: PR_HEAD,
  headRepository: REPO,
  headRepositoryId: REPOSITORY_ID,
  repository: REPO,
  repositoryId: REPOSITORY_ID,
};

/** @param {Record<string, unknown>} [overrides] */
function pr(overrides = {}) {
  return {
    user: { login: "dependabot[bot]" },
    base: { ref: "main" },
    head: { repo: { full_name: REPO } },
    state: "open",
    merged: false,
    merge_commit_sha: null,
    auto_merge: null,
    ...overrides,
  };
}

/** @param {Record<string, unknown>} [overrides] */
function ciRun(overrides = {}) {
  return {
    name: "CI",
    head_branch: "main",
    head_sha: TIP,
    path: ".github/workflows/ci.yml",
    event: "push",
    status: "completed",
    conclusion: "success",
    workflow_id: CI_WORKFLOW_ID,
    triggering_actor: { login: "tag0203" },
    ...overrides,
  };
}

describe("trustedPullRequestCi", () => {
  it("accepts this repository's successful pull_request CI", () => {
    expect(trustedPullRequestCi(trusted)).toMatchObject({ ok: true });
  });

  it("rejects forks, other events, and other workflows", () => {
    expect(trustedPullRequestCi({ ...trusted, event: "workflow_dispatch" }).ok).toBe(false);
    expect(trustedPullRequestCi({ ...trusted, event: "push" }).ok).toBe(false);
    expect(trustedPullRequestCi({ ...trusted, headRepository: "someone/kintore-memo", headRepositoryId: 9 }).ok).toBe(
      false,
    );
    expect(trustedPullRequestCi({ ...trusted, conclusion: "failure" }).ok).toBe(false);
    expect(trustedPullRequestCi({ ...trusted, workflowId: 1 }).ok).toBe(false);
  });
});

describe("classifyPulls", () => {
  it("waits for an open Dependabot pull request and stops for other authors", () => {
    expect(classifyPulls([pr({ auto_merge: { merge_method: "squash" } })], REPO)).toEqual({
      kind: "wait",
      autoMerge: true,
    });
    expect(classifyPulls([pr()], REPO)).toEqual({ kind: "wait", autoMerge: false });
    expect(classifyPulls([pr({ user: { login: "tag0203" } })], REPO).kind).toBe("stop");
    expect(classifyPulls([pr({ head: { repo: { full_name: "other/kintore-memo" } } })], REPO).kind).toBe("stop");
  });

  it("returns the squash SHA once the pull request is merged", () => {
    expect(classifyPulls([pr({ state: "closed", merged: true, merge_commit_sha: MERGE })], REPO)).toEqual({
      kind: "merged",
      sha: MERGE,
    });
    expect(classifyPulls([pr({ state: "closed", merged: true, merge_commit_sha: null })], REPO)).toEqual({
      kind: "wait",
      autoMerge: true,
    });
  });
});

describe("chooseDispatchTarget", () => {
  it("dispatches the tip when it is the merge or a descendant without CI", () => {
    expect(chooseDispatchTarget({ mergeSha: MERGE, mainSha: MERGE, compareStatus: "identical", runs: [] })).toEqual({
      dispatch: true,
      sha: MERGE,
      reason: "merged commit is the tip of main",
    });
    expect(chooseDispatchTarget({ mergeSha: MERGE, mainSha: TIP, compareStatus: "ahead", runs: [] })).toMatchObject({
      dispatch: true,
      sha: TIP,
    });
  });

  it("does not dispatch a diverged tip or a tip that already has CI", () => {
    expect(chooseDispatchTarget({ mergeSha: MERGE, mainSha: TIP, compareStatus: "diverged", runs: [] }).dispatch).toBe(
      false,
    );
    expect(
      chooseDispatchTarget({
        mergeSha: MERGE,
        mainSha: TIP,
        compareStatus: "identical",
        runs: [ciRun({ head_sha: TIP })],
      }).dispatch,
    ).toBe(false);
    expect(
      chooseDispatchTarget({
        mergeSha: MERGE,
        mainSha: TIP,
        compareStatus: "ahead",
        runs: [
          ciRun({
            event: "workflow_dispatch",
            triggering_actor: { login: "github-actions[bot]" },
            status: "in_progress",
            conclusion: null,
          }),
        ],
      }).dispatch,
    ).toBe(false);
  });

  it("ignores a human workflow_dispatch and a failed run", () => {
    expect(mainCiCovers([ciRun({ event: "workflow_dispatch", triggering_actor: { login: "tag0203" } })], TIP)).toBe(
      false,
    );
    expect(mainCiCovers([ciRun({ conclusion: "failure" })], TIP)).toBe(false);
    expect(mainCiCovers([ciRun({ event: "pull_request", head_branch: "dependabot/npm/left-pad" })], TIP)).toBe(false);
  });
});

describe("dispatchAfterPullRequestCi", () => {
  it("waits until auto-merge finishes, then dispatches CI for that main SHA", async () => {
    /** @type {string[]} */
    const posts = [];
    let pullsCalls = 0;
    /** @type {typeof fetch} */
    const fetchImpl = async (url, init = {}) => {
      const href = String(url);
      expect(href).not.toContain(TOKEN);
      expect(JSON.stringify(init.headers ?? {})).toContain(TOKEN);
      if (href.endsWith(`/commits/${PR_HEAD}/pulls`)) {
        pullsCalls += 1;
        const body =
          pullsCalls === 1
            ? [pr({ auto_merge: { merge_method: "squash" } })]
            : [pr({ state: "closed", merged: true, merge_commit_sha: MERGE })];
        return { ok: true, status: 200, json: async () => body };
      }
      if (href.endsWith("/commits/main")) {
        return { ok: true, status: 200, json: async () => ({ sha: MERGE }) };
      }
      if (href.includes("/compare/")) {
        return { ok: true, status: 200, json: async () => ({ status: "identical" }) };
      }
      if (href.includes("/actions/workflows/") && href.includes("/runs?")) {
        return { ok: true, status: 200, json: async () => ({ workflow_runs: [] }) };
      }
      if (href.endsWith("/dispatches") && init.method === "POST") {
        posts.push(String(init.body));
        return { ok: true, status: 204, json: async () => ({}) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    let now = 0;
    const result = await dispatchAfterPullRequestCi({
      token: TOKEN,
      repository: REPO,
      headSha: PR_HEAD,
      fetchImpl,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    expect(result).toEqual({ dispatched: true, sha: MERGE, reason: "merged commit is the tip of main" });
    expect(posts).toEqual([JSON.stringify({ ref: "main", inputs: { head_sha: MERGE } })]);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("stops without dispatching when the pull request stays open without auto-merge", async () => {
    /** @type {typeof fetch} */
    const fetchImpl = async (url) => {
      expect(String(url)).toContain("/pulls");
      return { ok: true, status: 200, json: async () => [pr()] };
    };
    let now = 0;
    const result = await dispatchAfterPullRequestCi({
      token: TOKEN,
      repository: REPO,
      headSha: PR_HEAD,
      fetchImpl,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    expect(result.dispatched).toBe(false);
    expect(now).toBeGreaterThanOrEqual(60_000);
  });
});
