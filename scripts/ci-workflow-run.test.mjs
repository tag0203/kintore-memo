import { describe, expect, it } from "vitest";
import {
  CI_WORKFLOW_ID,
  REPOSITORY_ID,
  isThisRepoCiPushOnMain,
  parseWorkflowRunPath,
} from "./ci-workflow-run.mjs";

const trusted = {
  name: "CI",
  path: ".github/workflows/ci.yml",
  workflowId: CI_WORKFLOW_ID,
  headBranch: "main",
  event: "push",
  conclusion: "success",
  headRepository: "tag0203/kintore-memo",
  headRepositoryId: REPOSITORY_ID,
  repository: "tag0203/kintore-memo",
  repositoryId: REPOSITORY_ID,
};

describe("parseWorkflowRunPath", () => {
  it("accepts the bare path and the documented @ref suffix", () => {
    expect(parseWorkflowRunPath(".github/workflows/ci.yml")).toEqual({
      file: ".github/workflows/ci.yml",
      ref: "",
    });
    expect(parseWorkflowRunPath(".github/workflows/ci.yml@main")).toEqual({
      file: ".github/workflows/ci.yml",
      ref: "main",
    });
    expect(parseWorkflowRunPath(".github/workflows/ci.yml@refs/heads/main")).toEqual({
      file: ".github/workflows/ci.yml",
      ref: "refs/heads/main",
    });
    expect(parseWorkflowRunPath(`.github/workflows/ci.yml@${"a".repeat(40)}`)).toEqual({
      file: ".github/workflows/ci.yml",
      ref: "a".repeat(40),
    });
  });

  it("rejects other files and other refs", () => {
    expect(parseWorkflowRunPath(".github/workflows/test.yml")).toBeNull();
    expect(parseWorkflowRunPath(".github/workflows/ci.yml@feature")).toBeNull();
    expect(parseWorkflowRunPath(".github/workflows/ci.yml@refs/heads/feature")).toBeNull();
    expect(parseWorkflowRunPath(".github/workflows/ci.yml@")).toBeNull();
    expect(parseWorkflowRunPath(".github/workflows/ci.yml.disabled")).toBeNull();
    expect(parseWorkflowRunPath("")).toBeNull();
  });
});

describe("isThisRepoCiPushOnMain", () => {
  it("accepts this repository's CI push on main, with or without a path suffix", () => {
    expect(isThisRepoCiPushOnMain(trusted)).toMatchObject({ ok: true });
    expect(isThisRepoCiPushOnMain({ ...trusted, path: ".github/workflows/ci.yml@main" })).toMatchObject({
      ok: true,
    });
    expect(
      isThisRepoCiPushOnMain({
        ...trusted,
        path: ".github/workflows/ci.yml@refs/heads/main",
        workflowId: String(CI_WORKFLOW_ID),
        repositoryId: String(REPOSITORY_ID),
      }),
    ).toMatchObject({ ok: true });
  });

  it("rejects a fork head, another workflow, and a non-main ref suffix", () => {
    expect(
      isThisRepoCiPushOnMain({
        ...trusted,
        headRepository: "someone/kintore-memo",
        headRepositoryId: 999,
      }).ok,
    ).toBe(false);
    expect(isThisRepoCiPushOnMain({ ...trusted, name: "test", workflowId: 372807335 }).ok).toBe(false);
    expect(isThisRepoCiPushOnMain({ ...trusted, path: ".github/workflows/ci.yml@feature" }).ok).toBe(false);
    expect(isThisRepoCiPushOnMain({ ...trusted, event: "pull_request" }).ok).toBe(false);
    expect(isThisRepoCiPushOnMain({ ...trusted, conclusion: "failure" }).ok).toBe(false);
    expect(isThisRepoCiPushOnMain({ ...trusted, headBranch: "feature" }).ok).toBe(false);
    expect(isThisRepoCiPushOnMain({ ...trusted, repositoryId: 1, headRepositoryId: 1 }).ok).toBe(false);
  });
});
