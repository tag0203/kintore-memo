import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");

/** @param {string} name */
function jobBlock(name) {
  const marker = `\n  ${name}:\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`missing job ${name}`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z0-9-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** @param {string} job */
function permissionsOf(job) {
  const lines = job.split("\n");
  const start = lines.findIndex((line) => line === "    permissions:");
  if (start < 0) throw new Error("missing permissions");
  /** @type {string[]} */
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("      ")) break;
    body.push(line.trim());
  }
  return body;
}

/** @param {string} text */
function gitExtraHeaderProblems(text) {
  /** @type {string[]} */
  const problems = [];
  for (const line of text.split("\n")) {
    if (/extraheader/i.test(line) && /bearer/i.test(line)) problems.push(line.trim());
    else if (/AUTHORIZATION:\s*bearer/i.test(line)) problems.push(line.trim());
  }
  return problems;
}

describe("deploy workflow git auth", () => {
  it("fetches origin/main with Basic x-access-token and never bearer in a git extraheader", () => {
    expect(
      gitExtraHeaderProblems('git -c "http.extraheader=AUTHORIZATION: bearer ${GITHUB_TOKEN}"'),
    ).toHaveLength(1);
    expect(gitExtraHeaderProblems("AUTHORIZATION: basic abc")).toEqual([]);
    const files = [
      ...readdirSync(new URL("../.github/workflows/", import.meta.url)).map((name) =>
        join(".github/workflows", name),
      ),
      ...readdirSync(new URL("./", import.meta.url))
        .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
        .map((name) => join("scripts", name)),
    ];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const problems = gitExtraHeaderProblems(text);
      if (problems.length > 0) {
        throw new Error(`${file} sends bearer to git: ${problems.join(" | ")}`);
      }
    }

    const b64At = workflow.indexOf(
      'GIT_AUTH_B64="$(printf \'x-access-token:%s\' "$GITHUB_TOKEN" | base64 -w0)"',
    );
    const maskAt = workflow.indexOf('echo "::add-mask::${GIT_AUTH_B64}"');
    const fetchAt = workflow.indexOf('git -c "http.extraheader=AUTHORIZATION: basic ${GIT_AUTH_B64}"');
    const unsetAt = workflow.indexOf("unset GIT_AUTH_B64");
    expect(b64At).toBeGreaterThan(0);
    expect(maskAt).toBeGreaterThan(b64At);
    expect(fetchAt).toBeGreaterThan(maskAt);
    expect(unsetAt).toBeGreaterThan(fetchAt);
    expect(workflow).toContain("fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main");
    expect(workflow).not.toMatch(/^\s*set -x\b/m);
  });

  it("builds the same Basic header as actions/checkout, without wrapping", () => {
    const token = `ghs_${"a".repeat(180)}+/=`;
    const encoded = execFileSync(
      "bash",
      ["-c", "printf 'x-access-token:%s' \"$TOKEN\" | base64 -w0"],
      { env: { PATH: process.env.PATH ?? "", TOKEN: token }, encoding: "utf8" },
    );
    expect(encoded).toBe(Buffer.from(`x-access-token:${token}`, "utf8").toString("base64"));
    expect(encoded).not.toMatch(/\s/);
    expect(`AUTHORIZATION: basic ${encoded}`).not.toMatch(/bearer/i);
  });
});

describe("deploy workflow token permissions", () => {
  it("keeps the gate read-only and gives the deployment recorder deployments:write", () => {
    expect(permissionsOf(jobBlock("gate"))).toEqual([
      "actions: read",
      "contents: read",
      "deployments: read",
    ]);
    expect(permissionsOf(jobBlock("record-dev-deployment"))).toEqual([
      "contents: read",
      "deployments: write",
    ]);
  });

  it("masks the role ARN in the gate script and does not read it from the variables API", () => {
    expect(workflow).not.toContain("actions/variables");
    expect(workflow).not.toContain("actions-variable.mjs");
    const shapeAt = workflow.indexOf(
      'if ! [[ "${AWS_DEPLOY_ROLE_ARN}" =~ ^arn:aws:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_-]+$ ]]; then',
    );
    const maskAt = workflow.indexOf('echo "::add-mask::${AWS_DEPLOY_ROLE_ARN}"');
    expect(shapeAt).toBeGreaterThan(0);
    expect(maskAt).toBeGreaterThan(shapeAt);
  });
});
