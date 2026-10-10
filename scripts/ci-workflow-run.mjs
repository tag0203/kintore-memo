import { pathToFileURL } from "node:url";

/** File path of the CI workflow. A run path may append `@ref`. */
export const CI_WORKFLOW_FILE = ".github/workflows/ci.yml";
export const CI_WORKFLOW_NAME = "CI";
/** Actions workflow id for `.github/workflows/ci.yml` in tag0203/kintore-memo. */
export const CI_WORKFLOW_ID = 372805829;
/** Immutable repository id. Forks and copies do not share it. */
export const REPOSITORY_ID = 1389679197;

const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Split a workflow run `path`.
 * The REST example is `.github/workflows/build.yml@main`. Live runs in this
 * repository currently omit the suffix. `@refs/heads/main` and a 40-hex
 * workflow-file SHA are accepted; the branch is checked separately.
 * @param {string} path
 * @returns {{ file: string, ref: string } | null}
 */
export function parseWorkflowRunPath(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > 512) return null;
  if (path.includes("\0") || path.includes("\\") || path.includes("..")) return null;
  const at = path.indexOf("@");
  if (at === -1) {
    return path === CI_WORKFLOW_FILE ? { file: path, ref: "" } : null;
  }
  const file = path.slice(0, at);
  const ref = path.slice(at + 1);
  if (file !== CI_WORKFLOW_FILE || ref.length === 0 || ref.includes("@") || ref.includes("/../")) {
    return null;
  }
  if (ref === "main" || ref === "refs/heads/main" || SHA_RE.test(ref)) {
    return { file, ref };
  }
  return null;
}

/**
 * True only for a successful push of this repository's CI workflow on main.
 * `headRepository` must be this repo, not a fork.
 * @param {{
 *   name?: string,
 *   path?: string,
 *   workflowId?: string | number,
 *   headBranch?: string,
 *   event?: string,
 *   conclusion?: string,
 *   headRepository?: string,
 *   headRepositoryId?: string | number,
 *   repository?: string,
 *   repositoryId?: string | number,
 * }} input
 * @returns {{ ok: boolean, reason: string }}
 */
export function isThisRepoCiPushOnMain(input) {
  if (input.conclusion !== "success") return { ok: false, reason: "CI did not succeed" };
  if (input.event !== "push") return { ok: false, reason: "triggering event is not push" };
  if (input.headBranch !== "main") return { ok: false, reason: "head branch is not main" };
  if (input.name !== CI_WORKFLOW_NAME) return { ok: false, reason: "workflow name is not CI" };
  if (Number(input.workflowId) !== CI_WORKFLOW_ID) {
    return { ok: false, reason: "workflow id is not this repository's CI workflow" };
  }
  if (!parseWorkflowRunPath(input.path ?? "")) {
    return { ok: false, reason: "workflow path is not .github/workflows/ci.yml on main" };
  }
  if (!input.repository || input.headRepository !== input.repository) {
    return { ok: false, reason: "head repository is not this repository" };
  }
  if (Number(input.headRepositoryId) !== Number(input.repositoryId)) {
    return { ok: false, reason: "head repository id does not match this repository" };
  }
  if (Number(input.repositoryId) !== REPOSITORY_ID) {
    return { ok: false, reason: "repository id is not kintore-memo" };
  }
  return { ok: true, reason: "CI push on main in this repository" };
}

function fromEnv() {
  return isThisRepoCiPushOnMain({
    name: process.env.TRIGGER_NAME,
    path: process.env.TRIGGER_PATH,
    workflowId: process.env.TRIGGER_WORKFLOW_ID,
    headBranch: process.env.HEAD_BRANCH,
    event: process.env.TRIGGER_EVENT,
    conclusion: process.env.TRIGGER_CONCLUSION,
    headRepository: process.env.HEAD_REPOSITORY,
    headRepositoryId: process.env.HEAD_REPOSITORY_ID,
    repository: process.env.GITHUB_REPOSITORY,
    repositoryId: process.env.REPOSITORY_ID,
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.stdout.write(`${JSON.stringify(fromEnv())}\n`);
}
