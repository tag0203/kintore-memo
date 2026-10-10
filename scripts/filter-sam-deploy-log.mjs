/**
 * Drop the CloudFormation outputs table that `sam deploy` prints after a
 * successful deploy. Progress and errors stay. The workflow still reads
 * values with describe-stacks and does not echo them.
 *
 * SAM writes the table from `_display_stack_outputs` after the header
 * "CloudFormation outputs from deployed stack", then
 * "Successfully created/updated stack - …". Description lines can wrap, so
 * the whole span is omitted, not just Key/Value rows.
 */
import { realpathSync } from "node:fs";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const OUTPUTS_HEADER = "CloudFormation outputs from deployed stack";
const OMITTED = "CloudFormation stack outputs omitted from the log.";
const SUCCESS_LINE = /^Successfully created\/updated stack\b/;
const FIELD_LINE = /^(?:Key|Description|Value)\s+\S/;
const RULE_LINE = /^-{10,}$/;
const JSON_OUTPUTS = /"type"\s*:\s*"outputs"|"stack_outputs"/;
const ERROR_LINE =
  /Traceback \(most recent call last\)|(?:^|\b)Error:|\bERROR\b|\bFAILED\b|[A-Za-z0-9_]+(?:Error|Exception):|An error occurred|botocore\.exceptions|WaiterError/;

/** @param {string} line */
function visible(line) {
  return line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/**
 * @param {string} line
 * @param {{ suppressing: boolean }} state
 * @returns {string[]}
 */
export function filterSamDeployLine(line, state) {
  const text = visible(line).trim();
  if (!state.suppressing && (text === OUTPUTS_HEADER || text.startsWith(`${OUTPUTS_HEADER} `))) {
    state.suppressing = true;
    return [OMITTED];
  }
  if (!state.suppressing && JSON_OUTPUTS.test(text)) {
    return [OMITTED];
  }
  if (!state.suppressing) return [line];

  if (SUCCESS_LINE.test(text)) {
    state.suppressing = false;
    return [line];
  }
  if (text === "" || text === "Outputs" || RULE_LINE.test(text) || FIELD_LINE.test(text)) {
    return [];
  }
  if (ERROR_LINE.test(text)) return [line];
  return [];
}

/** @param {string} text */
export function filterSamDeployLog(text) {
  const trailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (trailingNewline) lines.pop();
  const state = { suppressing: false };
  /** @type {string[]} */
  const out = [];
  for (const line of lines) {
    out.push(...filterSamDeployLine(line, state));
  }
  if (out.length === 0) return trailingNewline ? "\n" : "";
  return out.join("\n") + (trailingNewline ? "\n" : "");
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (isDirectRun()) {
  const state = { suppressing: false };
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    for (const out of filterSamDeployLine(line, state)) {
      process.stdout.write(`${out}\n`);
    }
  });
}
