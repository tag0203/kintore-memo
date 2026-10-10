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

/**
 * Decide whether an automatic dev deploy should publish this CI SHA.
 * Manual workflow_dispatch does not call this.
 *
 * Deploys the tested SHA when it changes application files and no newer
 * first-parent commit on the tip does. A newer docs-only commit still deploys
 * this SHA. A newer application commit skips, so a late CI run cannot roll
 * dev back over a newer revision.
 *
 * @param {string} repo
 * @param {string} headSha commit CI tested (`workflow_run.head_sha`)
 * @param {string} [tip] revision for current main. Default HEAD.
 * @returns {{ deploy: boolean, sha: string, reason: string }}
 */
export function planAutoDeploy(repo, headSha, tip = "HEAD") {
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

  const headFiles = changedFiles(repo, headSha);
  if (headFiles.length === 0) {
    return { deploy: false, sha: "", reason: "tested commit has no file changes" };
  }
  if (isDocsOnlyFileList(headFiles)) {
    return {
      deploy: false,
      sha: "",
      reason: "tested commit changes only docs or markdown",
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

  return {
    deploy: true,
    sha: headSha,
    reason: "CI passed for this application commit and main has no newer application commit",
  };
}

function parseArgs(argv) {
  /** @type {{ headSha?: string, repo: string, tip: string }} */
  const args = { repo: ".", tip: "HEAD" };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--head-sha" || flag === "--repo" || flag === "--tip") {
      if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value`);
      if (flag === "--head-sha") args.headSha = value;
      if (flag === "--repo") args.repo = value;
      if (flag === "--tip") args.tip = value;
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
  const plan = planAutoDeploy(args.repo, args.headSha, args.tip);
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
