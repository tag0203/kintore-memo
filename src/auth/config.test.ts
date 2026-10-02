import { describe, expect, it } from "vitest";
import { isAuthConfigured, readCognitoConfig } from "./config";

describe("readCognitoConfig", () => {
  it("returns null when any Cognito field is missing", () => {
    expect(
      readCognitoConfig({
        VITE_COGNITO_REGION: "ap-northeast-1",
        VITE_COGNITO_USER_POOL_ID: "",
        VITE_COGNITO_CLIENT_ID: "abc",
      }),
    ).toBeNull();
    expect(isAuthConfigured({ VITE_COGNITO_REGION: "ap-northeast-1" })).toBe(false);
  });

  it("reads public Cognito settings and strips trailing slash from API URL", () => {
    expect(
      readCognitoConfig({
        VITE_COGNITO_REGION: " ap-northeast-1 ",
        VITE_COGNITO_USER_POOL_ID: "ap-northeast-1_example",
        VITE_COGNITO_CLIENT_ID: "client123",
        VITE_API_BASE_URL: "https://example.execute-api.ap-northeast-1.amazonaws.com/dev/",
      }),
    ).toEqual({
      region: "ap-northeast-1",
      userPoolId: "ap-northeast-1_example",
      clientId: "client123",
      apiBaseUrl: "https://example.execute-api.ap-northeast-1.amazonaws.com/dev",
    });
  });
});
