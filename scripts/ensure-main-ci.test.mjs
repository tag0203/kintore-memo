import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CI_WORKFLOW_ID } from "./ci-workflow-run.mjs";
import { ensureMainCi, planEnsureMainCi } from "./ensure-main-ci.mjs";

const SHA = "a".repeat(40);
const TOKEN = "ghs_test_token_not_for_logs";
const REPO = "tag0203/kintore-memo";

/** @param {Record<string, unknown>} [overrides] */
function run(overrides = {}) {
  return {
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

describe("planEnsureMainCi", () => {
  it("dispatches when the tip has no CI, and skips a human push that already has CI", () => {
    expect(planEnsureMainCi({ sha: SHA, runs: [] })).toEqual({
      dispatch: true,
      sha: SHA,
      reason: "main has no successful or in-progress CI",
    });
    expect(planEnsureMainCi({ sha: SHA, runs: [run()] }).dispatch).toBe(false);
    expect(
      planEnsureMainCi({
        sha: SHA,
        runs: [run({ event: "workflow_dispatch", status: "in_progress", conclusion: null })],
      }).dispatch,
    ).toBe(false);
    expect(planEnsureMainCi({ sha: SHA, runs: [run({ conclusion: "failure" })] }).dispatch).toBe(true);
  });

  it("does not dispatch when the tip cannot be read", () => {
    expect(planEnsureMainCi({ sha: "tip", runs: [] }).dispatch).toBe(false);
    expect(planEnsureMainCi({ sha: SHA, runs: null }).dispatch).toBe(false);
  });
});

describe("ensureMainCi", () => {
  it("pins the dispatch to the tip it just read", async () => {
    /** @type {string[]} */
    const posts = [];
    /** @type {typeof fetch} */
    const fetchImpl = async (url, init = {}) => {
      const href = String(url);
      expect(href).not.toContain(TOKEN);
      if (href.endsWith("/commits/main")) return { ok: true, status: 200, json: async () => ({ sha: SHA }) };
      if (href.includes("/runs?")) return { ok: true, status: 200, json: async () => ({ workflow_runs: [] }) };
      if (href.endsWith("/dispatches") && init.method === "POST") {
        posts.push(String(init.body));
        return { ok: true, status: 204, json: async () => ({}) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const result = await ensureMainCi({ token: TOKEN, repository: REPO, fetchImpl });
    expect(result).toMatchObject({ dispatched: true, sha: SHA });
    expect(posts).toEqual([JSON.stringify({ ref: "main", inputs: { head_sha: SHA } })]);
  });

  it("is a no-op when push CI for that SHA is already running", async () => {
    /** @type {typeof fetch} */
    const fetchImpl = async (url, init = {}) => {
      const href = String(url);
      if (href.endsWith("/commits/main")) return { ok: true, status: 200, json: async () => ({ sha: SHA }) };
      if (href.includes("/runs?")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ workflow_runs: [run({ status: "in_progress", conclusion: null })] }),
        };
      }
      if (init.method === "POST") throw new Error("dispatched");
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const result = await ensureMainCi({ token: TOKEN, repository: REPO, fetchImpl });
    expect(result).toEqual({ dispatched: false, sha: "", reason: "main already has CI for this commit" });
  });
});

describe("ensure-main-ci workflow", () => {
  it("is one scheduler and does not take a SHA input", () => {
    const text = readFileSync(new URL("../.github/workflows/ensure-main-ci.yml", import.meta.url), "utf8");
    expect(text).toContain('cron: "17 * * * *"');
    expect(text).toContain("workflow_dispatch:");
    expect(text).not.toMatch(/workflow_dispatch:[\s\S]*inputs:/);
    expect(text).toContain("group: ensure-main-ci");
    expect(text).toContain("cancel-in-progress: false");
    const autoMerge = readFileSync(new URL("../.github/workflows/dependabot-auto-merge.yml", import.meta.url), "utf8");
    expect(autoMerge).not.toContain("workflow_run:");
    expect(autoMerge).not.toContain("dispatch-ci:");
  });
});
