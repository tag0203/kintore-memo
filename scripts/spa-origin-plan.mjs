/**
 * Decide the CloudFront origin passed to sam deploy.
 * Prints nothing about the domain. On failure, stderr is a fixed message.
 * Writes a shell env file that has already been pattern-checked.
 */
import { writeFileSync } from "node:fs";

const ORIGIN = /^https:\/\/[a-z0-9]+\.cloudfront\.net$/;
const READY = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"]);

/** @param {string | undefined} domain */
export function originFromDomain(domain) {
  const value = String(domain ?? "")
    .replaceAll("\r", "")
    .replaceAll("\n", "")
    .trim();
  if (!value || value === "None") return "";
  return `https://${value}`;
}

/**
 * @param {{ stackStatus: string, domain: string }} input
 * @returns {{ origin: string } | { error: string }}
 */
export function planBefore(input) {
  if (input.stackStatus === "ABSENT") return { origin: "" };
  if (!READY.has(input.stackStatus)) {
    return { error: `Refusing to deploy: StackStatus=${input.stackStatus}` };
  }
  return checkedOrigin(input.domain);
}

/**
 * @param {{ previousOrigin: string, domain: string }} input
 * @returns {{ origin: string, again: boolean } | { error: string }}
 */
export function planAfter(input) {
  const checked = checkedOrigin(input.domain);
  if ("error" in checked) return checked;
  return { origin: checked.origin, again: checked.origin !== input.previousOrigin };
}

/** @param {string} domain */
function checkedOrigin(domain) {
  const origin = originFromDomain(domain);
  if (!origin) return { error: "Refusing to deploy: CloudFront domain is missing." };
  if (!ORIGIN.test(origin)) {
    return { error: "Refusing to deploy: CloudFront domain did not match the expected pattern." };
  }
  return { origin };
}

/**
 * @param {string} path
 * @param {string} origin
 * @param {boolean | undefined} again
 */
export function writeOriginEnv(path, origin, again) {
  if (origin !== "" && !ORIGIN.test(origin)) {
    throw new Error("Refusing to write an origin that did not match the expected pattern.");
  }
  const lines = [`SPA_ALLOWED_ORIGIN='${origin}'`];
  if (again !== undefined) lines.push(`SPA_ORIGIN_AGAIN='${again ? "1" : "0"}'`);
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return entry.endsWith("spa-origin-plan.mjs");
}

if (isDirectRun()) {
  const phase = process.env.PHASE ?? "";
  const out = process.env.OUT_PATH ?? "";
  if (!out) {
    console.error("OUT_PATH is required.");
    process.exit(1);
  }
  if (phase === "before") {
    const result = planBefore({
      stackStatus: process.env.STACK_STATUS ?? "",
      domain: process.env.SPA_DOMAIN ?? "",
    });
    if ("error" in result) {
      console.error(result.error);
      process.exit(1);
    }
    writeOriginEnv(out, result.origin, undefined);
  } else if (phase === "after") {
    const result = planAfter({
      previousOrigin: process.env.PREVIOUS_ORIGIN ?? "",
      domain: process.env.SPA_DOMAIN ?? "",
    });
    if ("error" in result) {
      console.error(result.error);
      process.exit(1);
    }
    writeOriginEnv(out, result.origin, result.again);
  } else {
    console.error("PHASE must be before or after.");
    process.exit(1);
  }
}
