import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { planAfter, planBefore } from "./spa-origin-plan.mjs";

const script = fileURLToPath(new URL("./spa-origin-plan.mjs", import.meta.url));
const DOMAIN = "d111111abcdef8.cloudfront.net";

describe("spa origin plan", () => {
  it("omits the origin when the stack does not exist yet", () => {
    expect(planBefore({ stackStatus: "ABSENT", domain: "" })).toEqual({ origin: "" });
  });

  it("requires a cloudfront.net origin when the stack is already up", () => {
    expect(planBefore({ stackStatus: "UPDATE_COMPLETE", domain: DOMAIN })).toEqual({
      origin: `https://${DOMAIN}`,
    });
    expect(planBefore({ stackStatus: "UPDATE_COMPLETE", domain: "None" })).toEqual({
      error: "Refusing to deploy: CloudFront domain is missing.",
    });
    expect(planBefore({ stackStatus: "ROLLBACK_COMPLETE", domain: DOMAIN })).toEqual({
      error: "Refusing to deploy: StackStatus=ROLLBACK_COMPLETE",
    });
    expect(planBefore({ stackStatus: "UPDATE_COMPLETE", domain: "evil.example" }).error).toContain(
      "did not match",
    );
  });

  it("deploys again only when the live domain differs from the origin just applied", () => {
    expect(planAfter({ previousOrigin: `https://${DOMAIN}`, domain: DOMAIN })).toEqual({
      origin: `https://${DOMAIN}`,
      again: false,
    });
    expect(planAfter({ previousOrigin: "", domain: DOMAIN })).toEqual({
      origin: `https://${DOMAIN}`,
      again: true,
    });
  });

  it("writes a sourced env file and does not print the domain", () => {
    const dir = mkdtempSync(join(tmpdir(), "spa-origin-"));
    const out = join(dir, "origin.env");
    const result = spawnSync(process.execPath, [script], {
      env: {
        ...process.env,
        PHASE: "before",
        STACK_STATUS: "UPDATE_COMPLETE",
        SPA_DOMAIN: DOMAIN,
        OUT_PATH: out,
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(DOMAIN);
    expect(result.stderr).not.toContain(DOMAIN);
    expect(readFileSync(out, "utf8")).toBe(`SPA_ALLOWED_ORIGIN='https://${DOMAIN}'\n`);

    const rejected = spawnSync(process.execPath, [script], {
      env: {
        ...process.env,
        PHASE: "before",
        STACK_STATUS: "UPDATE_COMPLETE",
        SPA_DOMAIN: "evil.example",
        OUT_PATH: join(dir, "bad.env"),
      },
      encoding: "utf8",
    });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("did not match");
    expect(rejected.stderr).not.toContain("evil.example");
    expect(rejected.stdout).not.toContain("evil");
    rmSync(dir, { recursive: true, force: true });
  });
});
