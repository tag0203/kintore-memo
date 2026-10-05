import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** Browser / SPA leak patterns (names and hosts). Not applied under api/infra/docs/… */
const banned = [/NOTION_TOKEN/, /NOTION_DATABASE_ID/, /api\.notion\.com/, /VITE_NOTION/, /ntn_[A-Za-z0-9]+/, /secret_[A-Za-z0-9]+/];

/**
 * Real credential *values* scanned across every tracked file (including api/infra).
 * Config variable names alone must not match these.
 */
const secretValuePatterns = [
  { label: "ntn_ token value", pattern: /\bntn_[A-Za-z0-9]{20,}\b/ },
  { label: "secret_ token value", pattern: /\bsecret_[A-Za-z0-9]{20,}\b/ },
];

const allowed = new Set(["README.md", ".env.example", "wrangler.toml", "scripts/check-secrets.mjs"]);
const skipDirNames = new Set(["node_modules", ".git", ".wrangler", ".aws-sam", "coverage", "dev-dist"]);

function rel(root, path) {
  return relative(root, path).split("\\").join("/");
}

function isBrowserExempt(path) {
  return (
    path.startsWith("worker/") ||
    path.startsWith("api/") ||
    path.startsWith("infra/") ||
    path.startsWith("docs/") ||
    allowed.has(path)
  );
}

function isLocalEnvFile(pathRel) {
  const name = pathRel.split("/").pop() ?? "";
  return name === ".env" || (name.startsWith(".env.") && name !== ".env.example");
}

function readTracked(root) {
  try {
    const output = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(output.split("\0").filter(Boolean));
  } catch {
    return null;
  }
}

function scanSecretValues(text, pathRel, failures) {
  for (const { label, pattern } of secretValuePatterns) {
    if (pattern.test(text)) failures.push(`${pathRel} に ${label} があります`);
  }
}

/**
 * @param {string} root
 * @param {{ tracked?: Set<string> | null }} [options]
 * tracked を省略すると git ls-files を使う。null は git 不明で、.env は失敗させる。
 */
export function findLeaks(root, options = {}) {
  const tracked = options.tracked === undefined ? readTracked(root) : options.tracked;
  const failures = [];

  function walk(path, { inspectUntrackedEnv, scanValuesEverywhere }) {
    const info = statSync(path);
    if (info.isDirectory()) {
      for (const entry of readdirSync(path)) {
        if (skipDirNames.has(entry)) continue;
        if (entry === "dist" && path === root) continue;
        walk(join(path, entry), { inspectUntrackedEnv, scanValuesEverywhere });
      }
      return;
    }
    if (/\.(png|jpg|jpeg|webp|ico|woff2?)$/i.test(path)) return;

    const pathRel = rel(root, path);
    if (isLocalEnvFile(pathRel)) {
      if (tracked?.has(pathRel) || tracked === null) {
        failures.push(`${pathRel} はコミットしないでください`);
      }
      if (!inspectUntrackedEnv) return;
    }

    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return;
    }
    if (
      pathRel.startsWith("src/") &&
      /from\s+["'][^"']*worker\//.test(text)
    ) {
      failures.push(`${pathRel} が Worker を import しています`);
    }

    // Value-shaped secrets: every path under the walk (tracked tree + dist).
    if (scanValuesEverywhere) {
      scanSecretValues(text, pathRel, failures);
    }

    // Browser/SPA name+host patterns: skip api/infra/docs/worker.
    if (isBrowserExempt(pathRel)) return;
    for (const pattern of banned) {
      if (pattern.test(text)) failures.push(`${pathRel} に ${pattern} があります`);
    }
  }

  walk(root, { inspectUntrackedEnv: false, scanValuesEverywhere: true });

  const dist = join(root, "dist");
  if (existsSync(dist) && statSync(dist).isDirectory()) {
    walk(dist, { inspectUntrackedEnv: true, scanValuesEverywhere: true });
  }

  return failures;
}

const allowedExampleKeys = new Set([
  "NOTION_TOKEN",
  "NOTION_DATABASE_ID",
  // Cognito / API の公開設定（秘密ではない）。値は空のまま。
  "VITE_COGNITO_REGION",
  "VITE_COGNITO_USER_POOL_ID",
  "VITE_COGNITO_CLIENT_ID",
  "VITE_API_BASE_URL",
]);

function checkExample(root, failures) {
  const examplePath = join(root, ".env.example");
  if (!existsSync(examplePath)) return;
  const example = readFileSync(examplePath, "utf8");
  const keys = [];
  for (const line of example.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) {
      failures.push(`.env.example の行を解釈できません: ${trimmed}`);
      continue;
    }
    keys.push(match[1]);
    if (match[2].trim() !== "") failures.push(`${match[1]} は空にしてください`);
    if (!allowedExampleKeys.has(match[1])) {
      failures.push(`${match[1]} は .env.example で許可されていません`);
    }
  }
  for (const key of ["NOTION_TOKEN", "NOTION_DATABASE_ID"]) {
    if (!keys.includes(key)) failures.push(`.env.example に ${key} がありません`);
  }
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const failures = findLeaks(repoRoot);
  checkExample(repoRoot, failures);
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log("secret check ok");
}
