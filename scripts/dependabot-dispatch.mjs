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
 * `GET /commits/{sha}/pulls` returns Pull Request Simple objects.
 * That schema has `merged_at` and `merge_commit_sha`. It does not include the
 * boolean `merged` from the full pull-request resource. An open pull request
 * can still carry a test `merge_commit_sha`, so the timestamp is the merge signal.
 * @param {Record<string, unknown>} pr
 */
function mergedAt(pr) {
  return typeof pr.merged_at === "string" ? pr.merged_at : "";
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
  const merged = relevant.filter((pr) => mergedAt(pr).length > 0);
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
 * Merge commit SHAs from a pull list. Pull Request Simple uses `merged_at`;
 * a test `merge_commit_sha` on an unmerged pull request is ignored.
 * @param {unknown} pulls
 * @param {string} repository
 * @returns {string[]}
 */
export function mergeShas(pulls, repository) {
  if (!Array.isArray(pulls)) return [];
  /** @type {string[]} */
  const shas = [];
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
    if (mergedAt(pr).length === 0) continue;
    const sha = "merge_commit_sha" in pr ? String(pr.merge_commit_sha ?? "") : "";
    if (!SHA_RE.test(sha) || shas.includes(sha)) continue;
    shas.push(sha);
  }
  return shas;
}

/**
 * Decide whether to start CI on the current tip of main.
 * `workflow_dispatch` checks out `ref: main`, so only the tip can be pinned.
 * One run of that tip publishes every Dependabot squash it contains.
 * `contained` lists merge SHAs that are ancestors of the tip (the tip itself
 * is contained without being listed).
 * @param {{ mainSha: string, merges: string[], contained: string[], runs: unknown }} input
 * @returns {{ dispatch: boolean, sha: string, reason: string }}
 */
export function planReconcile(input) {
  if (!SHA_RE.test(input.mainSha)) {
    return { dispatch: false, sha: "", reason: "main SHA is not 40 lowercase hex characters" };
  }
  const merges = [...new Set((input.merges ?? []).filter((sha) => SHA_RE.test(sha)))];
  const contained = new Set((input.contained ?? []).filter((sha) => SHA_RE.test(sha)));
  const outstanding = merges.filter((sha) => sha === input.mainSha || contained.has(sha));
  if (outstanding.length === 0) {
    return { dispatch: false, sha: "", reason: "no Dependabot merge on main is waiting for CI" };
  }
  if (mainCiCovers(input.runs, input.mainSha)) {
    return { dispatch: false, sha: "", reason: "main already has CI for this commit" };
  }
  const onlyTip = outstanding.length === 1 && outstanding[0] === input.mainSha;
  return {
    dispatch: true,
    sha: input.mainSha,
    reason: onlyTip ? "merged commit is the tip of main" : "main tip contains Dependabot merges that have no CI",
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
 * @param {boolean} [allowFailure]
 */
async function api(fetchImpl, token, repository, path, init = {}, allowFailure = false) {
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
  if (!response.ok) {
    if (allowFailure) return null;
    throw new Error(`GitHub API ${response.status}`);
  }
  return response.json();
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} token
 * @param {string} repository
 */
async function readMainSha(fetchImpl, token, repository) {
  const main = await api(fetchImpl, token, repository, "/commits/main");
  return main && typeof main === "object" && "sha" in main ? String(main.sha) : "";
}

/**
 * Start CI for the tip of main when any recent Dependabot squash on main has
 * no CI yet. ref is the branch name main. CI rejects the run unless the
 * checked-out commit equals head_sha, so a tip that moved is not deployed.
 * @param {{ token: string, repository: string, extraMerge?: string, fetchImpl: typeof fetch }} options
 */
async function dispatchUncoveredTip(options) {
  const seen = new Set();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const mainSha = await readMainSha(options.fetchImpl, options.token, options.repository);
    if (!SHA_RE.test(mainSha)) {
      return { dispatched: false, sha: "", reason: "main SHA is not 40 lowercase hex characters" };
    }
    if (seen.has(mainSha)) {
      return { dispatched: false, sha: "", reason: "main moved while dispatching CI" };
    }
    const runsBody = await api(
      options.fetchImpl,
      options.token,
      options.repository,
      `/actions/workflows/${CI_WORKFLOW_ID}/runs?head_sha=${mainSha}&branch=main&per_page=20`,
    );
    const runs = runsBody && typeof runsBody === "object" && "workflow_runs" in runsBody ? runsBody.workflow_runs : [];
    if (mainCiCovers(runs, mainSha)) {
      return { dispatched: false, sha: "", reason: "main already has CI for this commit" };
    }
    const listed = await api(
      options.fetchImpl,
      options.token,
      options.repository,
      "/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=50",
    );
    const merges = mergeShas(listed, options.repository);
    if (options.extraMerge && !merges.includes(options.extraMerge)) merges.push(options.extraMerge);
    /** @type {string[]} */
    const contained = [];
    for (const sha of merges) {
      if (sha === mainSha) continue;
      const compare = await api(
        options.fetchImpl,
        options.token,
        options.repository,
        `/compare/${sha}...${mainSha}`,
        {},
        true,
      );
      const status = compare && typeof compare === "object" && "status" in compare ? String(compare.status) : "";
      if (status === "identical" || status === "ahead") contained.push(sha);
    }
    const target = planReconcile({ mainSha, merges, contained, runs });
    if (!target.dispatch) return { dispatched: false, sha: "", reason: target.reason };
    const againSha = await readMainSha(options.fetchImpl, options.token, options.repository);
    if (againSha !== target.sha) {
      seen.add(mainSha);
      continue;
    }
    await api(
      options.fetchImpl,
      options.token,
      options.repository,
      `/actions/workflows/${CI_WORKFLOW_ID}/dispatches`,
      {
        method: "POST",
        body: JSON.stringify({ ref: "main", inputs: { head_sha: target.sha } }),
      },
    );
    return { dispatched: true, sha: target.sha, reason: target.reason };
  }
  return { dispatched: false, sha: "", reason: "main moved while dispatching CI" };
}

/**
 * After pull-request CI succeeds, dispatch CI for the tip of main if it
 * contains a Dependabot squash that has no CI. Every CI completion runs this,
 * and each run has its own concurrency group, so a pending run is not replaced
 * by the next pull request. The scan still covers merges whose own run was lost.
 * GITHUB_TOKEN can start workflow_dispatch. The ref is always the branch main.
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
  /** @type {string} */
  let extraMerge = "";
  while (true) {
    const pulls = await api(fetchImpl, options.token, options.repository, `/commits/${options.headSha}/pulls`);
    const classified = classifyPulls(pulls, options.repository);
    if (classified.kind === "merged") extraMerge = classified.sha;
    if (classified.kind !== "wait") break;
    const limit = classified.autoMerge ? AUTO_MERGE_WAIT_MS : OPEN_GRACE_MS;
    if (now() - started >= limit) break;
    await sleep(POLL_MS);
  }
  return dispatchUncoveredTip({
    token: options.token,
    repository: options.repository,
    extraMerge,
    fetchImpl,
  });
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
