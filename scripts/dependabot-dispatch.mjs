import { pathToFileURL } from "node:url";
import { CI_WORKFLOW_ID, CI_WORKFLOW_NAME, REPOSITORY_ID, parseWorkflowRunPath } from "./ci-workflow-run.mjs";

const API = "https://api.github.com";
const SHA_RE = /^[0-9a-f]{40}$/;
const DEPENDABOT = "dependabot[bot]";
const ACTIONS_BOT = "github-actions[bot]";
const OPEN_GRACE_MS = 60_000;
const AUTO_MERGE_WAIT_MS = 10 * 60_000;
const POLL_MS = 10_000;

/**
 * The CI run that just finished must be a successful pull_request run of this
 * repository's CI workflow. Fork heads and workflow_dispatch runs are ignored
 * so dispatching CI cannot dispatch CI again.
 * @param {{
 *   conclusion?: string,
 *   event?: string,
 *   name?: string,
 *   workflowId?: string | number,
 *   headSha?: string,
 *   headRepository?: string,
 *   headRepositoryId?: string | number,
 *   repository?: string,
 *   repositoryId?: string | number,
 * }} input
 */
export function trustedPullRequestCi(input) {
  if (input.conclusion !== "success") return { ok: false, reason: "CI did not succeed" };
  if (input.event !== "pull_request") return { ok: false, reason: "CI event is not pull_request" };
  if (input.name !== CI_WORKFLOW_NAME) return { ok: false, reason: "workflow name is not CI" };
  if (Number(input.workflowId) !== CI_WORKFLOW_ID) {
    return { ok: false, reason: "workflow id is not this repository's CI workflow" };
  }
  if (!SHA_RE.test(input.headSha ?? "")) return { ok: false, reason: "head SHA is not 40 lowercase hex characters" };
  if (!input.repository || input.headRepository !== input.repository) {
    return { ok: false, reason: "head repository is not this repository" };
  }
  if (Number(input.headRepositoryId) !== Number(input.repositoryId)) {
    return { ok: false, reason: "head repository id does not match this repository" };
  }
  if (Number(input.repositoryId) !== REPOSITORY_ID) {
    return { ok: false, reason: "repository id is not kintore-memo" };
  }
  return { ok: true, reason: "Dependabot pull request CI in this repository" };
}

/**
 * @param {unknown} pulls
 * @param {string} repository
 * @returns {{ kind: "merged", sha: string } | { kind: "wait", autoMerge: boolean } | { kind: "stop", reason: string }}
 */
export function classifyPulls(pulls, repository) {
  if (!Array.isArray(pulls)) return { kind: "stop", reason: "pull list is not an array" };
  /** @type {Record<string, unknown>[]} */
  const relevant = [];
  for (const pr of pulls) {
    if (!pr || typeof pr !== "object") continue;
    const login = "user" in pr && pr.user && typeof pr.user === "object" && "login" in pr.user ? pr.user.login : "";
    const base = "base" in pr && pr.base && typeof pr.base === "object" && "ref" in pr.base ? pr.base.ref : "";
    const headRepo =
      "head" in pr && pr.head && typeof pr.head === "object" && "repo" in pr.head && pr.head.repo &&
      typeof pr.head.repo === "object" && "full_name" in pr.head.repo
        ? pr.head.repo.full_name
        : "";
    if (login !== DEPENDABOT || base !== "main") continue;
    if (headRepo && headRepo !== repository) continue;
    relevant.push(pr);
  }
  const merged = relevant.filter((pr) => pr.merged === true);
  if (merged.length > 0) {
    const withSha = merged.find((pr) => SHA_RE.test(String(pr.merge_commit_sha ?? "")));
    if (withSha) return { kind: "merged", sha: String(withSha.merge_commit_sha) };
    return { kind: "wait", autoMerge: true };
  }
  const open = relevant.find((pr) => pr.state === "open");
  if (open) return { kind: "wait", autoMerge: open.auto_merge != null };
  return { kind: "stop", reason: "no open or merged Dependabot pull request to main" };
}

/**
 * True when main already has a push CI run, or a github-actions workflow_dispatch
 * CI run, that is successful or still in progress for this SHA.
 * A failed or human-started run does not count.
 * @param {unknown} runs
 * @param {string} sha
 */
export function mainCiCovers(runs, sha) {
  if (!Array.isArray(runs)) return false;
  for (const run of runs) {
    if (!run || typeof run !== "object") continue;
    if (!("head_sha" in run) || run.head_sha !== sha) continue;
    if (!("head_branch" in run) || run.head_branch !== "main") continue;
    if (!("name" in run) || run.name !== CI_WORKFLOW_NAME) continue;
    if (!("workflow_id" in run) || Number(run.workflow_id) !== CI_WORKFLOW_ID) continue;
    if (!("path" in run) || !parseWorkflowRunPath(typeof run.path === "string" ? run.path : "")) continue;
    const event = "event" in run ? run.event : "";
    const triggering =
      "triggering_actor" in run && run.triggering_actor && typeof run.triggering_actor === "object" &&
      "login" in run.triggering_actor
        ? run.triggering_actor.login
        : "";
    const actor = "actor" in run && run.actor && typeof run.actor === "object" && "login" in run.actor ? run.actor.login : "";
    const bot = triggering === ACTIONS_BOT || (triggering === "" && actor === ACTIONS_BOT);
    if (event !== "push" && !(event === "workflow_dispatch" && bot)) continue;
    const status = "status" in run ? run.status : "";
    const conclusion = "conclusion" in run ? run.conclusion : "";
    if (status !== "completed") return true;
    if (conclusion === "success") return true;
  }
  return false;
}

/**
 * @param {{ mergeSha: string, mainSha: string, compareStatus: string, runs: unknown }} input
 * @returns {{ dispatch: boolean, sha: string, reason: string }}
 */
export function chooseDispatchTarget(input) {
  if (!SHA_RE.test(input.mergeSha) || !SHA_RE.test(input.mainSha)) {
    return { dispatch: false, sha: "", reason: "SHA is not 40 lowercase hex characters" };
  }
  if (input.compareStatus !== "identical" && input.compareStatus !== "ahead") {
    return { dispatch: false, sha: "", reason: "merge commit is not contained in main" };
  }
  if (mainCiCovers(input.runs, input.mainSha)) {
    return { dispatch: false, sha: "", reason: "main already has CI for this commit" };
  }
  return {
    dispatch: true,
    sha: input.mainSha,
    reason: input.compareStatus === "identical" ? "merged commit is the tip of main" : "main tip contains the merged commit",
  };
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
      "User-Agent": "kintore-memo-dependabot-dispatch",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`GitHub API ${response.status}`);
  return response.json();
}

/**
 * After Dependabot pull-request CI succeeds, dispatch CI on the main commit
 * that contains the squash. GITHUB_TOKEN can start workflow_dispatch.
 * The dispatched ref is always the branch name main. head_sha is the tip SHA
 * read from the API, and CI refuses the run unless GitHub checked out that SHA.
 * @param {{
 *   token: string,
 *   repository: string,
 *   headSha: string,
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 * }} options
 */
export async function dispatchAfterPullRequestCi(options) {
  if (!options.token) throw new Error("GITHUB_TOKEN is required");
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const started = now();
  while (true) {
    const pulls = await api(fetchImpl, options.token, options.repository, `/commits/${options.headSha}/pulls`);
    const classified = classifyPulls(pulls, options.repository);
    if (classified.kind === "stop") return { dispatched: false, sha: "", reason: classified.reason };
    if (classified.kind === "merged") {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const main = await api(fetchImpl, options.token, options.repository, "/commits/main");
        const mainSha = main && typeof main === "object" && "sha" in main ? String(main.sha) : "";
        if (!SHA_RE.test(mainSha)) {
          return { dispatched: false, sha: "", reason: "main SHA is not 40 lowercase hex characters" };
        }
        const compare = await api(
          fetchImpl,
          options.token,
          options.repository,
          `/compare/${classified.sha}...${mainSha}`,
        );
        const status = compare && typeof compare === "object" && "status" in compare ? String(compare.status) : "";
        const runsBody = await api(
          fetchImpl,
          options.token,
          options.repository,
          `/actions/workflows/${CI_WORKFLOW_ID}/runs?head_sha=${mainSha}&branch=main&per_page=20`,
        );
        const runs =
          runsBody && typeof runsBody === "object" && "workflow_runs" in runsBody ? runsBody.workflow_runs : [];
        const target = chooseDispatchTarget({
          mergeSha: classified.sha,
          mainSha,
          compareStatus: status,
          runs,
        });
        if (!target.dispatch) return { dispatched: false, sha: "", reason: target.reason };
        const again = await api(fetchImpl, options.token, options.repository, "/commits/main");
        const againSha = again && typeof again === "object" && "sha" in again ? String(again.sha) : "";
        if (againSha !== target.sha) continue;
        await api(fetchImpl, options.token, options.repository, `/actions/workflows/${CI_WORKFLOW_ID}/dispatches`, {
          method: "POST",
          body: JSON.stringify({ ref: "main", inputs: { head_sha: target.sha } }),
        });
        return { dispatched: true, sha: target.sha, reason: target.reason };
      }
      return { dispatched: false, sha: "", reason: "main moved while dispatching CI" };
    }
    const limit = classified.autoMerge ? AUTO_MERGE_WAIT_MS : OPEN_GRACE_MS;
    if (now() - started >= limit) {
      return { dispatched: false, sha: "", reason: "Dependabot pull request was not merged" };
    }
    await sleep(POLL_MS);
  }
}

function fromEnv() {
  return {
    conclusion: process.env.CI_CONCLUSION,
    event: process.env.CI_EVENT,
    name: process.env.CI_NAME,
    workflowId: process.env.CI_WORKFLOW_ID,
    headSha: process.env.CI_HEAD_SHA,
    headRepository: process.env.CI_HEAD_REPOSITORY,
    headRepositoryId: process.env.CI_HEAD_REPOSITORY_ID,
    repository: process.env.GITHUB_REPOSITORY,
    repositoryId: process.env.REPOSITORY_ID,
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const trusted = trustedPullRequestCi(fromEnv());
  if (!trusted.ok) {
    process.stdout.write(`${trusted.reason}\n`);
    process.exit(0);
  }
  dispatchAfterPullRequestCi({
    token: process.env.GITHUB_TOKEN ?? "",
    repository: process.env.GITHUB_REPOSITORY ?? "",
    headSha: process.env.CI_HEAD_SHA ?? "",
  })
    .then((result) => {
      process.stdout.write(`${result.reason}${result.sha ? ` ${result.sha}` : ""}\n`);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : "dispatch failed";
      process.stderr.write(`${message}\n`);
      process.exit(1);
    });
}
