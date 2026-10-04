import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findLeaks } from "./check-secrets.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const tokenName = ["NOTION", "TOKEN"].join("_");
const databaseName = ["NOTION", "DATABASE", "ID"].join("_");
const notionHost = ["api", "notion", "com"].join(".");
const workspaceEnv = join(repoRoot, ".env");

function workspaceEnvBytes() {
  return existsSync(workspaceEnv) ? readFileSync(workspaceEnv) : null;
}

function withWorkspaceEnvPreserved(run) {
  const before = workspaceEnvBytes();
  try {
    return run();
  } finally {
    expect(workspaceEnvBytes()).toEqual(before);
  }
}

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

  it("allows AWS infra, the Go API, the deprecated Node backend, and docs to name SSM parameters", () => {
    const root = writeTree({
      "infra/template.yaml": `${tokenName}_PARAM: /app/dev/notion/token\n`,
      "backend/index.mjs": `process.env.${tokenName}_PARAM\n`,
      "api/main.go": `os.Getenv("${tokenName}")\n`,
      "docs/aws-deploy.md": "aws ssm put-parameter --name /app/dev/notion/token\n",
      "src/app.ts": "export const label = 'スクワット';\n",
    });
    try {
      expect(
        findLeaks(root, {
          tracked: new Set([
            "infra/template.yaml",
            "backend/index.mjs",
            "api/main.go",
            "docs/aws-deploy.md",
            "src/app.ts",
          ]),
        }),
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a backend import of the worker reference", () => {
    const root = writeTree({
      "backend/index.mjs": "import { handleRequest } from \"../worker/index.ts\";\n",
      "src/app.ts": "export const label = 'スクワット';\n",
    });
    try {
      const failures = findLeaks(root, {
        tracked: new Set(["backend/index.mjs", "src/app.ts"]),
      });
      expect(failures.some((line) => line.includes("backend/index.mjs"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks an isolated git repo and keeps that repo's .env", () => {
    withWorkspaceEnvPreserved(() => {
      const root = mkdtempSync(join(tmpdir(), "kintore-secrets-repo-"));
      const envPath = join(root, ".env");
      const sentinel = `KEEP=${tokenName}-local-value\n`;
      try {
        mkdirSync(join(root, "scripts"));
        mkdirSync(join(root, "src"));
        cpSync(join(repoRoot, "scripts/check-secrets.mjs"), join(root, "scripts/check-secrets.mjs"));
        writeFileSync(join(root, ".gitignore"), ".env\n");
        writeFileSync(join(root, ".env.example"), `${tokenName}=\n${databaseName}=\n`);
        writeFileSync(join(root, "src/app.ts"), "export const label = 'スクワット';\n");
        execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
        execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
        writeFileSync(envPath, sentinel);

        const output = execFileSync(process.execPath, ["scripts/check-secrets.mjs"], {
          cwd: root,
          encoding: "utf8",
        });
        expect(output).toContain("secret check ok");
        expect(readFileSync(envPath, "utf8")).toBe(sentinel);

        writeFileSync(join(root, "src/leak.ts"), `export const token = "${tokenName}";\n`);
        execFileSync("git", ["add", "src/leak.ts"], { cwd: root, stdio: "ignore" });
        let failed = false;
        try {
          execFileSync(process.execPath, ["scripts/check-secrets.mjs"], {
            cwd: root,
            encoding: "utf8",
            stdio: "pipe",
          });
        } catch (error) {
          failed = true;
          expect(error.status).toBe(1);
          expect(String(error.stderr)).toContain("src/leak.ts");
        }
        expect(failed).toBe(true);
        expect(readFileSync(envPath, "utf8")).toBe(sentinel);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
