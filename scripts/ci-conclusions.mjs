import { pathToFileURL } from "node:url";
import { CI_WORKFLOW_ID, CI_WORKFLOW_NAME, parseWorkflowRunPath } from "./ci-workflow-run.mjs";
import { newerApplicationCommits } from "./auto-deploy-plan.mjs";

const SHA_RE = /^[0-9a-f]{40}$/;
const API = "https://api.github.com";
/** Newest newer-application commits whose CI status we look up. The rest stay unknown, which deploys. */
const MAX_LOOKUPS = 20;

/**
 * Latest push of this repository's CI workflow on main for `sha`.
 * Runs may arrive in any order. A non-completed latest run is pending.
 * Anything other than a completed success is not success.
 * @param {unknown} runs
 * @param {string} sha
 * @returns {"success" | "failure" | "pending" | "unknown"}
 */
export function selectPushCiConclusion(runs, sha) {
  if (!Array.isArray(runs)) return "unknown";
  /** @type {{ id: number, status: unknown, conclusion: unknown }[]} */
  const matching = [];
  for (const run of runs) {
    if (!run || typeof run !== "object") continue;
    if (!("head_sha" in run) || run.head_sha !== sha) continue;
    if (!("event" in run) || run.event !== "push") continue;
    if (!("head_branch" in run) || run.head_branch !== "main") continue;
    if (!("workflow_id" in run) || Number(run.workflow_id) !== CI_WORKFLOW_ID) continue;
    if (!("name" in run) || run.name !== CI_WORKFLOW_NAME) continue;
    if (!("path" in run) || !parseWorkflowRunPath(typeof run.path === "string" ? run.path : "")) continue;
    const id = "id" in run && typeof run.id === "number" ? run.id : 0;
    matching.push({
      id,
      status: "status" in run ? run.status : null,
      conclusion: "conclusion" in run ? run.conclusion : null,
    });
  }
  if (matching.length === 0) return "unknown";
  matching.sort((left, right) => right.id - left.id);
  const latest = matching[0];
  if (latest.status !== "completed") return "pending";
  if (latest.conclusion === "success") return "success";
  if (typeof latest.conclusion === "string" && latest.conclusion.length > 0) return "failure";
  return "unknown";
}

/** @param {string} repository */
function repositoryPath(repository) {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error("repository must be owner/name");
  }
  return `${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`;
}

/** @param {string} token */
function apiHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "kintore-memo-deploy",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * CI conclusions for the given SHAs. An HTTP or parse failure for one SHA is
 * `unknown` for that SHA and does not fail the others. Unknown does not suppress deploy.
 * @param {{ token: string, repository: string, shas: string[], fetchImpl?: typeof fetch }} options
 * @returns {Promise<Record<string, "success" | "failure" | "pending" | "unknown">>}
 */
export async function fetchPushCiConclusions(options) {
  if (!options.token) throw new Error("GITHUB_TOKEN is required to read CI runs");
  const path = repositoryPath(options.repository);
  const fetchImpl = options.fetchImpl ?? fetch;
  /** @type {Record<string, "success" | "failure" | "pending" | "unknown">} */
  const conclusions = {};
  for (const sha of options.shas.slice(0, MAX_LOOKUPS)) {
    if (!SHA_RE.test(sha)) {
      conclusions[sha] = "unknown";
      continue;
    }
    const url = `${API}/repos/${path}/actions/workflows/${CI_WORKFLOW_ID}/runs?head_sha=${sha}&branch=main&event=push&per_page=10`;
    try {
      const response = await fetchImpl(url, { headers: apiHeaders(options.token) });
      if (!response.ok) {
        conclusions[sha] = "unknown";
        continue;
      }
      const body = await response.json();
      const runs = body && typeof body === "object" && "workflow_runs" in body ? body.workflow_runs : null;
      conclusions[sha] = selectPushCiConclusion(runs, sha);
    } catch {
      conclusions[sha] = "unknown";
    }
  }
  return conclusions;
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

async function main() {
  const token = process.env.GITHUB_TOKEN ?? "";
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const args = parseArgs(process.argv.slice(2));
  const newer = newerApplicationCommits(args.repo, args.headSha, args.tip);
  const newestFirst = [...newer].reverse();
  const conclusions = newer.length === 0 ? {} : await fetchPushCiConclusions({ token, repository, shas: newestFirst });
  process.stdout.write(`${JSON.stringify(conclusions)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "CI conclusion lookup failed";
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
