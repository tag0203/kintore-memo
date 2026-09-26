import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findLeaks } from "./check-secrets.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const tokenName = ["NOTION", "TOKEN"].join("_");
const databaseName = ["NOTION", "DATABASE", "ID"].join("_");
const notionHost = ["api", "notion", "com"].join(".");

function writeTree(files) {
  const root = mkdtempSync(join(tmpdir(), "kintore-secrets-"));
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

describe("secret check", () => {
  it("allows an untracked local env file, including one that holds a token", () => {
    const root = writeTree({
      ".env": `${tokenName}=local-only\n${databaseName}=local-db\n`,
      "src/app.ts": "export const label = 'スクワット';\n",
      "worker/client.ts": `const name = '${tokenName}';\n`,
    });
    try {
      expect(findLeaks(root, { tracked: new Set(["src/app.ts", "worker/client.ts"]) })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still fails for tracked env files, browser source, tracked config, and dist", () => {
    const root = writeTree({
      ".env": "# comment only\n",
      "src/app.ts": `export const token = '${tokenName}';\n`,
      "config.json": `{ "id": "${databaseName}" }\n`,
      "dist/bundle.js": `fetch('https://${notionHost}/v1/pages')\n`,
    });
    try {
      const failures = findLeaks(root, {
        tracked: new Set([".env", "src/app.ts", "config.json"]),
      });
      expect(failures.some((line) => line.includes(".env"))).toBe(true);
      expect(failures.some((line) => line.includes("src/app.ts"))).toBe(true);
      expect(failures.some((line) => line.includes("config.json"))).toBe(true);
      expect(failures.some((line) => line.includes("dist/bundle.js"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes the repo check while a comment-only .env is present", () => {
    const envPath = join(repoRoot, ".env");
    writeFileSync(envPath, "# local notes only\n");
    try {
      const output = execFileSync(process.execPath, ["scripts/check-secrets.mjs"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      expect(output).toContain("secret check ok");
    } finally {
      rmSync(envPath, { force: true });
    }
  });
});
