import { describe, expect, it } from "vitest";
import { readRequestId } from "./requestId";

describe("readRequestId", () => {
  it("keeps an API Gateway token", () => {
    expect(readRequestId(" ZoG1fH0oIAMEjeg= ")).toBe("ZoG1fH0oIAMEjeg=");
  });

  it("drops an ARN, an account id, a token, and Notion ids", () => {
    expect(readRequestId("arn:aws:iam::123456789012:root")).toBe("");
    expect(readRequestId("123456789012")).toBe("");
    expect(readRequestId("https://example.invalid/req")).toBe("");
    expect(readRequestId("ntn_" + "secretvalue")).toBe("");
    expect(readRequestId("secret_" + "ABC123456")).toBe("");
    expect(readRequestId("a1b2c3d4e5f64789a123ef1234567890")).toBe("");
    expect(readRequestId("a1b2c3d4-e5f6-4789-a123-ef1234567890")).toBe("");
    expect(readRequestId("11111111-2222-4333-8444-555555555555")).toBe("");
  });
});
