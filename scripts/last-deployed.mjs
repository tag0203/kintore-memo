import { pathToFileURL } from "node:url";

const SHA_RE = /^[0-9a-f]{40}$/;
const API = "https://api.github.com";
const DEV_ENVIRONMENT = "dev";
const UNSETTLED = new Set(["pending", "queued", "in_progress"]);

/**
 * Newest deployment whose latest settled status is success, or inactive after success.
 * `deployments` is newest first. Each `statuses` list is newest first.
 * In-progress, failed, and inactive-without-success records are skipped.
 * @param {{ sha?: string, statuses?: string[] }[]} deployments
 * @returns {string | null}
 */
export function selectLastSuccessfulDeploymentSha(deployments) {
  if (!Array.isArray(deployments)) return null;
  for (const deployment of deployments) {
    if (!deployment || typeof deployment.sha !== "string" || !SHA_RE.test(deployment.sha)) continue;
    const statuses = Array.isArray(deployment.statuses) ? deployment.statuses : [];
    const settled = statuses.find((state) => typeof state === "string" && !UNSETTLED.has(state));
    if (settled === "success") return deployment.sha;
    if (settled === "inactive" && statuses.includes("success")) return deployment.sha;
  }
  return null;
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
 * REST only. Git smart HTTP does not accept Bearer for GITHUB_TOKEN.
 * deploy.yml sends Basic x-access-token for `git fetch`.
 * @param {string} token
 */
function apiHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "kintore-memo-deploy",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * @param {Response} response
 * @param {string} label
 */
async function readJson(response, label) {
  if (!response.ok) {
    throw new Error(`${label} failed: HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * @param {string} url
 * @param {string} path
 * @returns {string | null}
 */
function deploymentIdFromStatusesUrl(url, path) {
  const prefix = `${API}/repos/${path}/deployments/`;
  const suffix = "/statuses";
  if (!url.startsWith(prefix) || !url.endsWith(suffix)) return null;
  const id = url.slice(prefix.length, -suffix.length);
  return /^[0-9]+$/.test(id) ? id : null;
}

/**
 * SHA of the latest successful GitHub deployment for `dev`, or null when none exist.
 * Looks at the 20 newest deployment records. An API failure throws; the caller deploys.
 * @param {{ token: string, repository: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<string | null>}
 */
export async function fetchLastDeployedSha(options) {
  const token = options.token;
  if (!token) throw new Error("GITHUB_TOKEN is required to read deployments");
  const path = repositoryPath(options.repository);
  const fetchImpl = options.fetchImpl ?? fetch;
  const listUrl = `${API}/repos/${path}/deployments?environment=${encodeURIComponent(DEV_ENVIRONMENT)}&per_page=20`;
  const listed = await readJson(await fetchImpl(listUrl, { headers: apiHeaders(token) }), "list deployments");
  if (!Array.isArray(listed)) throw new Error("list deployments returned a non-array");

  for (const deployment of listed.slice(0, 20)) {
    if (!deployment || typeof deployment !== "object") continue;
    const sha = "sha" in deployment && typeof deployment.sha === "string" ? deployment.sha : "";
    const statusesUrl = "statuses_url" in deployment && typeof deployment.statuses_url === "string" ? deployment.statuses_url : "";
    if (!deploymentIdFromStatusesUrl(statusesUrl, path)) continue;
    const statusPayload = await readJson(
      await fetchImpl(statusesUrl, { headers: apiHeaders(token) }),
      "list deployment statuses",
    );
    if (!Array.isArray(statusPayload)) continue;
    const statuses = statusPayload
      .map((status) => (status && typeof status === "object" && "state" in status ? status.state : null))
      .filter((state) => typeof state === "string");
    const selected = selectLastSuccessfulDeploymentSha([{ sha, statuses }]);
    if (selected) return selected;
  }
  return null;
}

/**
 * Record a successful `dev` deployment for this SHA.
 * Called only after the dev publish has succeeded. Staging and prod do not call this.
 * @param {{ token: string, repository: string, sha: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ id: number, sha: string }>}
 */
export async function recordSuccessfulDevDeployment(options) {
  const token = options.token;
  if (!token) throw new Error("GITHUB_TOKEN is required to record a deployment");
  if (!SHA_RE.test(options.sha)) throw new Error("deployed SHA must be 40 lowercase hex characters");
  const path = repositoryPath(options.repository);
  const fetchImpl = options.fetchImpl ?? fetch;
  const created = await readJson(
    await fetchImpl(`${API}/repos/${path}/deployments`, {
      method: "POST",
      headers: apiHeaders(token),
      body: JSON.stringify({
        ref: options.sha,
        environment: DEV_ENVIRONMENT,
        auto_merge: false,
        required_contexts: [],
        transient_environment: false,
        production_environment: false,
        description: "kintore-memo dev",
      }),
    }),
    "create deployment",
  );
  const id = created && typeof created === "object" && "id" in created ? created.id : null;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
    throw new Error("create deployment returned no id");
  }
  await readJson(
    await fetchImpl(`${API}/repos/${path}/deployments/${id}/statuses`, {
      method: "POST",
      headers: apiHeaders(token),
      body: JSON.stringify({
        state: "success",
        environment: DEV_ENVIRONMENT,
        description: "Deployed kintore-memo dev",
        auto_inactive: true,
      }),
    }),
    "create deployment status",
  );
  return { id, sha: options.sha };
}

function parseArgs(argv) {
  if (argv.length === 0) return { recordSha: null };
  if (argv.length === 2 && argv[0] === "--record") {
    if (!argv[1] || argv[1].startsWith("-")) throw new Error("--record requires a SHA");
    return { recordSha: argv[1] };
  }
  throw new Error("usage: last-deployed.mjs [--record <sha>]");
}

async function main() {
  const token = process.env.GITHUB_TOKEN ?? "";
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const args = parseArgs(process.argv.slice(2));
  if (args.recordSha) {
    const recorded = await recordSuccessfulDevDeployment({ token, repository, sha: args.recordSha });
    process.stdout.write(`Recorded dev deployment ${recorded.id} for ${recorded.sha}\n`);
    return;
  }
  const sha = await fetchLastDeployedSha({ token, repository });
  process.stdout.write(sha ?? "");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "last deployed SHA lookup failed";
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
