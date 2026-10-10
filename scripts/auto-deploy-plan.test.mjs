import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isDocsOnlyFileList, isDocsPath, planAutoDeploy } from "./auto-deploy-plan.mjs";

/** @param {string} repo @param {string[]} args */
function git(repo, args) {
  execFileSync("git", args, {
    cwd: repo,
    stdio: "ignore",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" },
  });
}

function initRepo() {
  const root = mkdtempSync(join(tmpdir(), "kintore-auto-deploy-"));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "auto-deploy test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  return root;
}

/** @param {string} repo @param {Record<string, string>} files */
function commitFiles(repo, files, message) {
  for (const [path, contents] of Object.entries(files)) {
    const full = join(repo, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents);
  }
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", message]);
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
}

function head(repo) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
}

function parentOf(repo, sha) {
  return execFileSync("git", ["rev-parse", `${sha}^`], { cwd: repo, encoding: "utf8" }).trim();
}

describe("docs path filter", () => {
  it("treats docs/ and markdown as non-application changes", () => {
    expect(isDocsPath("docs/aws-deploy.md")).toBe(true);
    expect(isDocsPath("docs/images/diagram.png")).toBe(true);
    expect(isDocsPath("README.md")).toBe(true);
    expect(isDocsPath("src/notes.markdown")).toBe(true);
    expect(isDocsPath("src/README.MD")).toBe(true);
    expect(isDocsPath("src/app.ts")).toBe(false);
    expect(isDocsPath("docs-extra/app.ts")).toBe(false);
    expect(isDocsPath("documentation/notes.txt")).toBe(false);
    expect(isDocsOnlyFileList(["README.md", "docs/images/diagram.png"])).toBe(true);
    expect(isDocsOnlyFileList(["README.md", "src/app.ts"])).toBe(false);
    expect(isDocsOnlyFileList([])).toBe(false);
  });
});

describe("planAutoDeploy", () => {
  it("deploys a commit that changes application files", () => {
    const repo = initRepo();
    try {
      const sha = commitFiles(repo, { "src/app.ts": "export {}\n", "README.md": "# hi\n" }, "app");
      expect(planAutoDeploy(repo, sha)).toEqual({
        deploy: true,
        sha,
        reason: "push range is unknown, so deploy the tested tree",
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("skips a push whose whole range is docs or markdown", () => {
    const repo = initRepo();
    try {
      const base = commitFiles(repo, { "src/app.ts": "export {}\n" }, "app");
      const sha = commitFiles(
        repo,
        { "README.md": "# hi\n", "docs/images/diagram.png": "png\n" },
        "docs",
      );
      const plan = planAutoDeploy(repo, sha, "HEAD", { beforeSha: base });
      expect(plan.deploy).toBe(false);
      expect(plan.reason).toBe("pushed range changes only docs or markdown");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("skips an empty commit", () => {
    const repo = initRepo();
    try {
      commitFiles(repo, { "src/app.ts": "export {}\n" }, "app");
      git(repo, ["commit", "--allow-empty", "-m", "empty"]);
      const sha = head(repo);
      const before = parentOf(repo, sha);
      expect(planAutoDeploy(repo, sha, "HEAD", { beforeSha: before })).toMatchObject({
        deploy: false,
        sha: "",
        reason: "pushed range has no file changes",
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("still deploys the tested application SHA when only docs landed after it", () => {
    const repo = initRepo();
    try {
      const app = commitFiles(repo, { "src/app.ts": "export {}\n" }, "app");
      commitFiles(repo, { "docs/aws-deploy.md": "# deploy\n" }, "docs");
      expect(planAutoDeploy(repo, app).deploy).toBe(true);
      expect(planAutoDeploy(repo, app).sha).toBe(app);
      expect(planAutoDeploy(repo, head(repo), "HEAD", { beforeSha: app }).deploy).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("skips an older application SHA when a newer application commit is on main", () => {
    const repo = initRepo();
    try {
      const older = commitFiles(repo, { "src/a.ts": "a\n" }, "a");
      const newer = commitFiles(repo, { "src/b.ts": "b\n" }, "b");
      const olderPlan = planAutoDeploy(repo, older);
      expect(olderPlan.deploy).toBe(false);
      expect(olderPlan.reason).toContain(newer);
      expect(planAutoDeploy(repo, newer)).toMatchObject({ deploy: true, sha: newer });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("deploys the tested tip when an earlier commit in the same push changes the app", () => {
    const repo = initRepo();
    try {
      const before = commitFiles(repo, { "README.md": "# base\n" }, "base");
      commitFiles(repo, { "src/app.ts": "export {}\n" }, "app");
      const tip = commitFiles(repo, { "docs/aws-deploy.md": "# docs\n" }, "docs tip");
      expect(planAutoDeploy(repo, tip, "HEAD", { beforeSha: before })).toMatchObject({
        deploy: true,
        sha: tip,
        reason: "CI passed for this push and main has no newer application commit",
      });
      expect(planAutoDeploy(repo, tip, "HEAD", { beforeSha: parentOf(repo, tip) }).deploy).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("deploys when the push baseline is missing or not in the repository", () => {
    const repo = initRepo();
    try {
      const base = commitFiles(repo, { "src/app.ts": "export {}\n" }, "app");
      const tip = commitFiles(repo, { "README.md": "# only docs\n" }, "docs");
      expect(planAutoDeploy(repo, tip).deploy).toBe(true);
      expect(planAutoDeploy(repo, tip, "HEAD", { beforeSha: "0".repeat(40) }).deploy).toBe(true);
      expect(
        planAutoDeploy(repo, tip, "HEAD", { beforeSha: "b".repeat(40) }),
      ).toMatchObject({ deploy: true, sha: tip });
      expect(planAutoDeploy(repo, tip, "HEAD", { beforeSha: base }).deploy).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("deploys a merge commit's application diff and ignores a side-branch SHA", () => {
    const repo = initRepo();
    try {
      commitFiles(repo, { "README.md": "# hi\n" }, "docs");
      git(repo, ["checkout", "-b", "feature"]);
      const side = commitFiles(repo, { "src/feature.ts": "feature\n" }, "feature");
      git(repo, ["checkout", "main"]);
      git(repo, ["merge", "--no-ff", "feature", "-m", "merge feature"]);
      const merge = head(repo);
      expect(planAutoDeploy(repo, side)).toMatchObject({
        deploy: false,
        reason: "tested SHA is not on the first-parent history of main",
      });
      expect(planAutoDeploy(repo, merge)).toMatchObject({ deploy: true, sha: merge });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("skips a SHA that is not on the requested tip", () => {
    const repo = initRepo();
    try {
      const onMain = commitFiles(repo, { "src/app.ts": "export {}\n" }, "app");
      git(repo, ["checkout", "-b", "other"]);
      const other = commitFiles(repo, { "src/other.ts": "other\n" }, "other");
      git(repo, ["checkout", "main"]);
      expect(planAutoDeploy(repo, other, "main")).toMatchObject({ deploy: false, sha: "" });
      expect(planAutoDeploy(repo, onMain, "main").deploy).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("prints a one-line JSON plan from the CLI", () => {
    const repo = initRepo();
    try {
      const sha = commitFiles(repo, { "src/app.ts": "export {}\n" }, "app");
      const script = fileURLToPath(new URL("./auto-deploy-plan.mjs", import.meta.url));
      const output = execFileSync(process.execPath, [script, "--head-sha", sha, "--repo", repo, "--tip", "HEAD"], {
        encoding: "utf8",
      });
      expect(output.endsWith("\n")).toBe(true);
      expect(output.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(output)).toEqual({
        deploy: true,
        sha,
        reason: "push range is unknown, so deploy the tested tree",
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects a SHA that is not 40 lowercase hex characters", () => {
    const repo = initRepo();
    try {
      expect(() => planAutoDeploy(repo, "HEAD")).toThrow(/40 lowercase hex/);
      expect(() => planAutoDeploy(repo, "not-a-sha")).toThrow(/40 lowercase hex/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
