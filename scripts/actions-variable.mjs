import { pathToFileURL } from "node:url";

const API = "https://api.github.com";
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
 * @param {string} token
 */
function apiHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "kintore-memo-deploy",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * Repository Actions variable value, or null when the variable does not exist.
 * Other HTTP statuses throw. The error does not include the response body or the token.
 * @param {{ token: string, repository: string, name: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<string | null>}
 */
export async function fetchActionsVariable(options) {
  const token = options.token;
  if (!token) throw new Error("GITHUB_TOKEN is required to read an Actions variable");
  if (!NAME_RE.test(options.name)) throw new Error("variable name is invalid");
  const path = repositoryPath(options.repository);
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${API}/repos/${path}/actions/variables/${encodeURIComponent(options.name)}`;
  const response = await fetchImpl(url, { headers: apiHeaders(token) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`read actions variable failed: HTTP ${response.status}`);
  const body = await response.json();
  if (!body || typeof body !== "object" || !("value" in body) || typeof body.value !== "string") {
    throw new Error("read actions variable returned no value");
  }
  return body.value;
}

function parseArgs(argv) {
  if (argv.length !== 1 || !argv[0] || argv[0].startsWith("-")) {
    throw new Error("usage: actions-variable.mjs <name>");
  }
  return argv[0];
}

async function main() {
  const name = parseArgs(process.argv.slice(2));
  const value = await fetchActionsVariable({
    token: process.env.GITHUB_TOKEN ?? "",
    repository: process.env.GITHUB_REPOSITORY ?? "",
    name,
  });
  process.stdout.write(value ?? "");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "actions variable lookup failed";
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
