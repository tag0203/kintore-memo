import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const banned = [/NOTION_TOKEN/, /NOTION_DATABASE_ID/, /api\.notion\.com/, /VITE_NOTION/, /ntn_[A-Za-z0-9]/, /secret_[A-Za-z0-9]/];
const allowed = new Set(["README.md", ".env.example", "wrangler.toml", "scripts/check-secrets.mjs"]);
const skipDirNames = new Set(["node_modules", ".git", ".wrangler", ".aws-sam", "coverage", "dev-dist"]);

function rel(root, path) {
  return relative(root, path).split("\\").join("/");
}

function isAllowed(path) {
  return (
    path.startsWith("worker/") ||
    path.startsWith("backend/") ||
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

/**
 * @param {string} root
 * @param {{ tracked?: Set<string> | null }} [options]
 * tracked を省略すると git ls-files を使う。null は git 不明で、.env は失敗させる。
 */
export function findLeaks(root, options = {}) {
  const tracked = options.tracked === undefined ? readTracked(root) : options.tracked;
  const failures = [];

  function walk(path, { inspectUntrackedEnv }) {
    const info = statSync(path);
    if (info.isDirectory()) {
      for (const entry of readdirSync(path)) {
        if (skipDirNames.has(entry)) continue;
        if (entry === "dist" && path === root) continue;
        walk(join(path, entry), { inspectUntrackedEnv });
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
    if (pathRel.startsWith("src/") && /from\s+["'][^"']*worker\//.test(text)) {
      failures.push(`${pathRel} が Worker を import しています`);
    }
    if (isAllowed(pathRel)) return;
    for (const pattern of banned) {
      if (pattern.test(text)) failures.push(`${pathRel} に ${pattern} があります`);
    }
  }

  walk(root, { inspectUntrackedEnv: false });

  const dist = join(root, "dist");
  if (existsSync(dist) && statSync(dist).isDirectory()) {
    walk(dist, { inspectUntrackedEnv: true });
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
