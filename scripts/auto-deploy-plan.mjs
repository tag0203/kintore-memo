import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Docs and markdown do not change the deployed app.
 * `docs/` is the docs tree. `*.md` and `*.markdown` anywhere else count too.
 * Matching is case-sensitive for the directory and case-insensitive for the extension.
 * @param {string} filePath
 */
export function isDocsPath(filePath) {
  const path = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (path === "docs" || path.startsWith("docs/")) return true;
  return /\.(?:md|markdown)$/i.test(path);
}

/** @param {string[]} files */
export function isDocsOnlyFileList(files) {
  return files.length > 0 && files.every(isDocsPath);
}

/**
 * @param {string} repo
 * @param {string[]} args
 * @param {{ allowFailure?: boolean }} [options]
 * @returns {string | null}
 */
function git(repo, args, options = {}) {
  try {
    return execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (options.allowFailure) return null;
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr ?? "") : "";
    throw new Error(`git ${args[0] ?? ""} failed: ${stderr.trim()}`);
  }
}

/** @param {string} sha */
function assertSha(sha) {
  if (!SHA_RE.test(sha)) {
    throw new Error("commit SHA must be 40 lowercase hex characters");
  }
}

/**
 * Paths changed by this commit relative to its first parent.
 * A root commit lists the tree. An empty commit returns [].
 * @param {string} repo
 * @param {string} sha
 */
function changedFiles(repo, sha) {
  assertSha(sha);
  const parent = git(repo, ["rev-parse", "--verify", "--quiet", `${sha}^`], { allowFailure: true });
  const parentSha = parent?.trim() ?? "";
  if (parentSha) {
    assertSha(parentSha);
    const output = git(repo, ["diff", "--name-only", "-z", parentSha, sha]);
    return output.split("\0").filter(Boolean);
  }
  const output = git(repo, ["ls-tree", "-r", "--name-only", "-z", sha]);
  return output.split("\0").filter(Boolean);
}

/**
 * @param {string} repo
 * @param {string} tipSha
 */
function firstParentLine(repo, tipSha) {
  const output = git(repo, ["rev-list", "--first-parent", "--reverse", tipSha]);
  const line = output
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const sha of line) assertSha(sha);
  return line;
}

const ZERO_SHA = "0".repeat(40);
const DEPLOY_REASON = "CI passed for this push and main has no newer application commit";
const UNKNOWN_RANGE_REASON = "push range is unknown, so deploy the tested tree";

/**
 * Net files changed between the push baseline and the tested tip.
 * Missing or zero `before` is uncertain: the caller deploys.
 * @param {string} repo
 * @param {string} headSha
 * @param {string | null | undefined} beforeSha
 * @returns {{ uncertain: boolean, files: string[] }}
 */
function pushRangeFiles(repo, headSha, beforeSha) {
  if (beforeSha == null || beforeSha === "" || beforeSha === ZERO_SHA) {
    return { uncertain: true, files: [] };
  }
  assertSha(beforeSha);
  const exists = git(repo, ["cat-file", "-e", `${beforeSha}^{commit}`], { allowFailure: true });
  if (exists === null) return { uncertain: true, files: [] };
  const output = git(repo, ["diff", "--name-only", "-z", beforeSha, headSha]);
  return { uncertain: false, files: output.split("\0").filter(Boolean) };
}

/**
 * Decide whether an automatic dev deploy should publish this CI SHA.
 * Manual workflow_dispatch does not call this.
 *
 * The docs-only check covers the whole push (`before`..`headSha`), not only
 * the tip commit. CI runs once per push, so an earlier application commit in
 * that push has no run of its own. Unknown range deploys the tested tip.
 * A newer application commit on main still skips, so a late run cannot roll
 * dev back.
 *
 * @param {string} repo
 * @param {string} headSha commit CI tested (`workflow_run.head_sha`)
 * @param {string} [tip] revision for current main. Default HEAD.
 * @param {{ beforeSha?: string | null }} [options] push baseline (`github.event.before`)
 * @returns {{ deploy: boolean, sha: string, reason: string }}
 */
export function planAutoDeploy(repo, headSha, tip = "HEAD", options = {}) {
  assertSha(headSha);
  if (tip.startsWith("-") || tip.includes(" ")) {
    throw new Error("tip must be a single git revision");
  }
  const resolvedTip = git(repo, ["rev-parse", "--verify", `${tip}^{commit}`])?.trim() ?? "";
  assertSha(resolvedTip);
  const line = firstParentLine(repo, resolvedTip);
  const index = line.indexOf(headSha);
  if (index < 0) {
    return {
      deploy: false,
      sha: "",
      reason: "tested SHA is not on the first-parent history of main",
    };
  }

  for (const later of line.slice(index + 1)) {
    const files = changedFiles(repo, later);
    if (files.length === 0 || isDocsOnlyFileList(files)) continue;
    return {
      deploy: false,
      sha: "",
      reason: `a newer commit on main changes application files (${later})`,
    };
  }

  const range = pushRangeFiles(repo, headSha, options.beforeSha);
  if (range.uncertain) {
    return { deploy: true, sha: headSha, reason: UNKNOWN_RANGE_REASON };
  }
  if (range.files.length === 0) {
    return { deploy: false, sha: "", reason: "pushed range has no file changes" };
  }
  if (isDocsOnlyFileList(range.files)) {
    return {
      deploy: false,
      sha: "",
      reason: "pushed range changes only docs or markdown",
    };
  }

  return { deploy: true, sha: headSha, reason: DEPLOY_REASON };
}

function parseArgs(argv) {
  /** @type {{ headSha?: string, repo: string, tip: string, beforeSha?: string }} */
  const args = { repo: ".", tip: "HEAD" };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--head-sha" || flag === "--repo" || flag === "--tip" || flag === "--before-sha") {
      if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value`);
      if (flag === "--head-sha") args.headSha = value;
      if (flag === "--repo") args.repo = value;
      if (flag === "--tip") args.tip = value;
      if (flag === "--before-sha") args.beforeSha = value;
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${flag}`);
  }
  if (!args.headSha) throw new Error("--head-sha is required");
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = planAutoDeploy(args.repo, args.headSha, args.tip, { beforeSha: args.beforeSha });
  process.stdout.write(`${JSON.stringify(plan)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "auto-deploy plan failed";
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
