import { describe, expect, it } from "vitest";
import { inlineDocumentViolations, renderCsp } from "./csp-policy.mjs";

describe("CSP document check", () => {
  it("accepts external scripts and rejects inline script, style, and handlers", () => {
    expect(
      inlineDocumentViolations('<script type="module" src="/assets/index.js"></script>'),
    ).toEqual([]);
    expect(inlineDocumentViolations("<script>alert(1)</script>")).toEqual(["inline script"]);
    expect(inlineDocumentViolations("<style>body{}</style>")).toEqual(["style element"]);
    expect(inlineDocumentViolations('<div style="color:red"></div>')).toEqual(["style attribute"]);
    expect(inlineDocumentViolations('<button onclick="x()"></button>')).toEqual([
      "inline event handler",
    ]);
  });

  it("refuses a wildcard or an unresolved substitution", () => {
    expect(() => renderCsp("connect-src *", "ap-northeast-1", "a1b2c3d4e5")).toThrow(/wildcard/);
    expect(() => renderCsp("connect-src ${Other}", "ap-northeast-1", "a1b2c3d4e5")).toThrow(
      /unresolved/,
    );
  });
});
