import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CI_WORKFLOW_ID, REPOSITORY_ID } from "./ci-workflow-run.mjs";
import {
  classifyPulls,
  dispatchAfterPullRequestCi,
  mainCiCovers,
  mergeShas,
  planReconcile,
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

/**
 * Shape of one element from `GET /repos/{owner}/{repo}/commits/{sha}/pulls`
 * (Pull Request Simple). That payload has `merged_at` and `merge_commit_sha`
 * and does not include the boolean `merged`.
 * @param {Record<string, unknown>} [overrides]
 */
function pr(overrides = {}) {
  return {
    user: { login: "dependabot[bot]" },
    base: { ref: "main" },
    head: { ref: "dependabot/npm/left-pad-1.2.4", repo: { full_name: REPO } },
    state: "open",
    merged_at: null,
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

  it("uses merged_at from the commits/pulls payload, not a merged boolean", () => {
    const merged = pr({
      state: "closed",
      merged_at: "2026-11-22T09:48:00Z",
      merge_commit_sha: MERGE,
    });
    expect(merged).not.toHaveProperty("merged");
    expect(classifyPulls([merged], REPO)).toEqual({ kind: "merged", sha: MERGE });
    expect(
      classifyPulls([pr({ state: "closed", merged_at: "2026-11-22T09:48:00Z", merge_commit_sha: null })], REPO),
    ).toEqual({ kind: "wait", autoMerge: true });
    // GitHub fills merge_commit_sha with a test merge while the pull request is still open.
    expect(
      classifyPulls([pr({ merge_commit_sha: MERGE })], REPO),
    ).toEqual({ kind: "wait", autoMerge: false });
    // Closed without merged_at is not a merge, even if a test SHA is still present.
    expect(
      classifyPulls([pr({ state: "closed", merged_at: null, merge_commit_sha: MERGE })], REPO).kind,
    ).toBe("stop");
  });
});

describe("planReconcile", () => {
  it("dispatches the tip when it is the only merge or it contains earlier merges", () => {
    expect(planReconcile({ mainSha: MERGE, merges: [MERGE], contained: [], runs: [] })).toEqual({
      dispatch: true,
      sha: MERGE,
      reason: "merged commit is the tip of main",
    });
    expect(planReconcile({ mainSha: TIP, merges: [MERGE, TIP], contained: [MERGE], runs: [] })).toEqual({
      dispatch: true,
      sha: TIP,
      reason: "main tip contains Dependabot merges that have no CI",
    });
  });

  it("still dispatches the tip when the earlier dispatcher was dropped", () => {
    // Thirteen Dependabot PRs merged together. Pending dispatchers share a
    // concurrency group and GitHub cancels all but one, even with
    // cancel-in-progress false. The survivor must cover every squash that
    // landed, not only the pull request that triggered it.
    const dropped = Array.from({ length: 12 }, (_, index) => `${index.toString(16).padStart(40, "d")}`);
    expect(
      planReconcile({
        mainSha: TIP,
        merges: [...dropped, TIP],
        contained: dropped,
        runs: [],
      }),
    ).toMatchObject({ dispatch: true, sha: TIP });
  });

  it("does not dispatch a diverged merge or a tip that already has CI", () => {
    expect(planReconcile({ mainSha: TIP, merges: [MERGE], contained: [], runs: [] }).dispatch).toBe(false);
    expect(
      planReconcile({
        mainSha: TIP,
        merges: [TIP],
        contained: [],
        runs: [ciRun({ head_sha: TIP })],
      }).dispatch,
    ).toBe(false);
    expect(
      planReconcile({
        mainSha: TIP,
        merges: [MERGE, TIP],
        contained: [MERGE],
        runs: [
          ciRun({
            head_sha: TIP,
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

describe("mergeShas", () => {
  it("keeps merged Dependabot squashes and ignores a test merge SHA", () => {
    expect(
      mergeShas(
        [
          pr({ state: "closed", merged_at: "2026-11-14T00:00:00Z", merge_commit_sha: MERGE }),
          pr({ state: "closed", merged_at: "2026-11-14T00:01:00Z", merge_commit_sha: TIP }),
          pr({ merge_commit_sha: "e".repeat(40) }),
          pr({ user: { login: "tag0203" }, state: "closed", merged_at: "2026-11-14T00:02:00Z", merge_commit_sha: "f".repeat(40) }),
        ],
        REPO,
      ),
    ).toEqual([MERGE, TIP]);
  });
});

describe("dispatch concurrency", () => {
  it("gives every CI run its own group so a pending dispatcher is not replaced", () => {
    const text = readFileSync(new URL("../.github/workflows/dependabot-auto-merge.yml", import.meta.url), "utf8");
    const job = text.slice(text.indexOf("  dispatch-ci:"));
    expect(job).toContain("group: dependabot-post-merge-${{ github.event.workflow_run.id }}");
    expect(job).not.toContain("group: dependabot-post-merge-dispatch");
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
            : [pr({ state: "closed", merged_at: "2026-11-22T09:48:00Z", merge_commit_sha: MERGE })];
        return { ok: true, status: 200, json: async () => body };
      }
      if (href.includes("/pulls?state=closed")) {
        return {
          ok: true,
          status: 200,
          json: async () => [pr({ state: "closed", merged_at: "2026-11-22T09:48:00Z", merge_commit_sha: MERGE })],
        };
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

  it("dispatches the later tip when this run was not the pull request that merged it", async () => {
    /** @type {string[]} */
    const posts = [];
    /** @type {typeof fetch} */
    const fetchImpl = async (url, init = {}) => {
      const href = String(url);
      if (href.endsWith(`/commits/${PR_HEAD}/pulls`)) {
        return {
          ok: true,
          status: 200,
          json: async () => [pr({ state: "closed", merged_at: "2026-11-14T01:00:00Z", merge_commit_sha: MERGE })],
        };
      }
      if (href.includes("/pulls?state=closed")) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            pr({ state: "closed", merged_at: "2026-11-14T02:00:00Z", merge_commit_sha: TIP }),
            pr({ state: "closed", merged_at: "2026-11-14T01:00:00Z", merge_commit_sha: MERGE }),
          ],
        };
      }
      if (href.endsWith("/commits/main")) {
        return { ok: true, status: 200, json: async () => ({ sha: TIP }) };
      }
      if (href.includes(`/compare/${MERGE}...${TIP}`)) {
        return { ok: true, status: 200, json: async () => ({ status: "ahead" }) };
      }
      if (href.includes("/runs?")) {
        return { ok: true, status: 200, json: async () => ({ workflow_runs: [] }) };
      }
      if (href.endsWith("/dispatches") && init.method === "POST") {
        posts.push(String(init.body));
        return { ok: true, status: 204, json: async () => ({}) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const result = await dispatchAfterPullRequestCi({
      token: TOKEN,
      repository: REPO,
      headSha: PR_HEAD,
      fetchImpl,
      now: () => 0,
      sleep: async () => {},
    });
    expect(result).toMatchObject({ dispatched: true, sha: TIP });
    expect(posts).toEqual([JSON.stringify({ ref: "main", inputs: { head_sha: TIP } })]);
  });

  it("stops without dispatching when the pull request stays open without auto-merge", async () => {
    /** @type {typeof fetch} */
    const fetchImpl = async (url) => {
      const href = String(url);
      if (href.endsWith(`/commits/${PR_HEAD}/pulls`)) {
        return { ok: true, status: 200, json: async () => [pr()] };
      }
      if (href.endsWith("/commits/main")) {
        return { ok: true, status: 200, json: async () => ({ sha: TIP }) };
      }
      if (href.includes("/runs?")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ workflow_runs: [ciRun({ head_sha: TIP })] }),
        };
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
    expect(result.dispatched).toBe(false);
    expect(now).toBeGreaterThanOrEqual(60_000);
  });
});
