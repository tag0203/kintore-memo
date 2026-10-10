/**
 * Parse the SPA Content-Security-Policy from infra/template.yaml and check
 * the built document for markup that policy would block.
 */

const CSP_MARKER = 'ContentSecurityPolicy: !Sub "';

/** @param {string} template */
export function extractCspSub(template) {
  const start = template.indexOf(CSP_MARKER);
  if (start < 0) throw new Error("CSP !Sub was not found in the template");
  const from = start + CSP_MARKER.length;
  const end = template.indexOf('"', from);
  if (end < 0) throw new Error("CSP !Sub is not a single quoted line");
  return template.slice(from, end);
}

/**
 * @param {string} sub
 * @param {string} region
 * @param {string} apiId
 */
export function renderCsp(sub, region, apiId) {
  if (!/^[a-z0-9-]+$/.test(region)) throw new Error("region did not match the expected pattern");
  if (!/^[a-z0-9]+$/.test(apiId)) throw new Error("API id did not match the expected pattern");
  const rendered = sub.replaceAll("${AWS::Region}", region).replaceAll("${HttpApi}", apiId);
  if (rendered.includes("${") || rendered.includes("}")) {
    throw new Error("CSP still has an unresolved substitution");
  }
  if (rendered.includes("*")) throw new Error("CSP contains a wildcard");
  if (/unsafe-inline|unsafe-eval/.test(rendered)) {
    throw new Error("CSP allows inline or eval script");
  }
  return rendered;
}

/**
 * Markup in the HTML document that a script-src/style-src 'self' policy blocks.
 * Style attributes are included because style-src-attr falls back to style-src.
 * @param {string} html
 * @returns {string[]}
 */
export function inlineDocumentViolations(html) {
  /** @type {string[]} */
  const violations = [];
  const scripts = html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    const attrs = match[1] ?? "";
    const body = (match[2] ?? "").trim();
    if (!/\bsrc\s*=/i.test(attrs) && body.length > 0) violations.push("inline script");
  }
  if (/<style\b/i.test(html)) violations.push("style element");
  if (/\sstyle\s*=/i.test(html)) violations.push("style attribute");
  if (/\son[a-z]+\s*=/i.test(html)) violations.push("inline event handler");
  return violations;
}
