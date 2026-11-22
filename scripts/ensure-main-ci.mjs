import { pathToFileURL } from "node:url";
import { CI_WORKFLOW_ID, CI_WORKFLOW_NAME, REPOSITORY_ID, parseWorkflowRunPath } from "./ci-workflow-run.mjs";

const API = "https://api.github.com";
const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * True when this CI workflow already succeeded, or is still running, for `sha` on main.
 * Push, a bot dispatch, and a human dispatch all count. A failed run does not,
 * so the next hourly check can try again.
 * @param {unknown} run
 * @param {string} sha
 */
function coversSha(run, sha) {
  if (!run || typeof run !== "object") return false;
  if (!("head_sha" in run) || run.head_sha !== sha) return false;
  if (!("head_branch" in run) || run.head_branch !== "main") return false;
  if (!("name" in run) || run.name !== CI_WORKFLOW_NAME) return false;
  if (!("workflow_id" in run) || Number(run.workflow_id) !== CI_WORKFLOW_ID) return false;
  if (!("path" in run) || !parseWorkflowRunPath(typeof run.path === "string" ? run.path : "")) return false;
  const status = "status" in run ? run.status : "";
  const conclusion = "conclusion" in run ? run.conclusion : "";
  if (status !== "completed") return true;
  return conclusion === "success";
}

/**
 * Dispatch only when main's tip has no successful CI and none in progress.
 * Unreadable input does not dispatch.
 * @param {{ sha: string, runs: unknown }} input
 * @returns {{ dispatch: boolean, sha: string, reason: string }}
 */
export function planEnsureMainCi(input) {
  if (!SHA_RE.test(input.sha)) {
    return { dispatch: false, sha: "", reason: "main SHA is not 40 lowercase hex characters" };
  }
  if (!Array.isArray(input.runs)) {
    return { dispatch: false, sha: "", reason: "CI runs are unreadable" };
  }
  if (input.runs.some((run) => coversSha(run, input.sha))) {
    return { dispatch: false, sha: "", reason: "main already has CI for this commit" };
  }
  return { dispatch: true, sha: input.sha, reason: "main has no successful or in-progress CI" };
}

/** @param {string} repository */
function repositoryPath(repository) {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error("repository must be owner/name");
  }
  return `${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`;
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} token
 * @param {string} repository
 * @param {string} path
 * @param {{ method?: string, body?: string }} [init]
 */
async function api(fetchImpl, token, repository, path, init = {}) {
  const response = await fetchImpl(`${API}/repos/${repositoryPath(repository)}${path}`, {
    method: init.method ?? "GET",
    body: init.body,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "kintore-memo-ensure-main-ci",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`GitHub API ${response.status}`);
  return response.json();
}

/**
 * Read main's tip once and dispatch CI for that SHA when it has no CI.
 * If main moves before the run starts, that run fails the pin check and the
 * next hourly run tries the new tip. A duplicate run is left for GitHub.
 * @param {{ token: string, repository: string, fetchImpl?: typeof fetch }} options
 */
export async function ensureMainCi(options) {
  if (!options.token) throw new Error("GITHUB_TOKEN is required");
  const fetchImpl = options.fetchImpl ?? fetch;
  const main = await api(fetchImpl, options.token, options.repository, "/commits/main");
  const sha = main && typeof main === "object" && "sha" in main ? String(main.sha) : "";
  if (!SHA_RE.test(sha)) return { dispatched: false, sha: "", reason: "main SHA is not 40 lowercase hex characters" };
  const runsBody = await api(
    fetchImpl,
    options.token,
    options.repository,
    `/actions/workflows/${CI_WORKFLOW_ID}/runs?head_sha=${sha}&branch=main&per_page=20`,
  );
  const runs = runsBody && typeof runsBody === "object" && "workflow_runs" in runsBody ? runsBody.workflow_runs : null;
  const plan = planEnsureMainCi({ sha, runs });
  if (!plan.dispatch) return { dispatched: false, sha: "", reason: plan.reason };
  await api(fetchImpl, options.token, options.repository, `/actions/workflows/${CI_WORKFLOW_ID}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: "main", inputs: { head_sha: plan.sha } }),
  });
  return { dispatched: true, sha: plan.sha, reason: plan.reason };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (Number(process.env.REPOSITORY_ID) !== REPOSITORY_ID) {
    process.stdout.write("repository id is not kintore-memo\n");
    process.exit(0);
  }
  ensureMainCi({
    token: process.env.GITHUB_TOKEN ?? "",
    repository: process.env.GITHUB_REPOSITORY ?? "",
  })
    .then((result) => {
      process.stdout.write(`${result.reason}${result.sha ? ` ${result.sha}` : ""}\n`);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : "could not ensure main CI";
      process.stderr.write(`${message}\n`);
      process.exit(1);
    });
}
