import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const banned = [/NOTION_TOKEN/, /NOTION_DATABASE_ID/, /api\.notion\.com/, /VITE_NOTION/, /ntn_[A-Za-z0-9]/, /secret_[A-Za-z0-9]/];
const skipDirs = new Set(["node_modules", "dist", "dev-dist", ".git", ".wrangler", "coverage"]);
const allowed = new Set(["README.md", ".env.example", "wrangler.toml", "scripts/check-secrets.mjs"]);

const failures = [];

function rel(path) {
  return relative(root, path).split("\\").join("/");
}

function isAllowed(path) {
  return path.startsWith("worker/") || allowed.has(path);
}

function scan(path, { enforce } = { enforce: true }) {
  const info = statSync(path);
  if (info.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (skipDirs.has(entry) && path === root) continue;
      scan(join(path, entry), { enforce });
    }
    return;
  }
  if (/\.(png|jpg|jpeg|webp|ico|woff2?)$/i.test(path)) return;
  const pathRel = rel(path);
  if (pathRel === ".env" || pathRel.startsWith(".env.") && pathRel !== ".env.example") {
    failures.push(`${pathRel} はコミットしないでください`);
  }
  const text = readFileSync(path, "utf8");
  if (pathRel.startsWith("src/") && /from\s+["'][^"']*worker\//.test(text)) {
    failures.push(`${pathRel} が Worker を import しています`);
  }
  if (!enforce || isAllowed(pathRel)) return;
  for (const pattern of banned) {
    if (pattern.test(text)) failures.push(`${pathRel} に ${pattern} があります`);
  }
}

scan(root);

const examplePath = join(root, ".env.example");
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
  if (!match[1].startsWith("NOTION_")) failures.push(`${match[1]} は NOTION_ 以外です`);
}
for (const key of ["NOTION_TOKEN", "NOTION_DATABASE_ID"]) {
  if (!keys.includes(key)) failures.push(`.env.example に ${key} がありません`);
}

const dist = join(root, "dist");
try {
  if (statSync(dist).isDirectory()) scan(dist, { enforce: true });
} catch {
  // ビルド前は dist が無くてよい。
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("secret check ok");
