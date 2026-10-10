import { describe, expect, it } from "vitest";
import { readRequestId } from "./requestId";

describe("readRequestId", () => {
  it("keeps a Lambda UUID and an API Gateway token", () => {
    expect(readRequestId(" 11111111-2222-4333-8444-555555555555 ")).toBe(
      "11111111-2222-4333-8444-555555555555",
    );
    expect(readRequestId("ZoG1fH0oIAMEjeg=")).toBe("ZoG1fH0oIAMEjeg=");
  });

  it("drops an ARN, an account id, a token, and a compact Notion id", () => {
    expect(readRequestId("arn:aws:iam::123456789012:root")).toBe("");
    expect(readRequestId("123456789012")).toBe("");
    expect(readRequestId("https://example.invalid/req")).toBe("");
    expect(readRequestId("ntn_" + "secretvalue")).toBe("");
    expect(readRequestId("secret_" + "ABC123456")).toBe("");
    expect(readRequestId("a1b2c3d4e5f64789a123ef1234567890")).toBe("");
  });
});
