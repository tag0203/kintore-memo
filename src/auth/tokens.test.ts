import { describe, expect, it } from "vitest";
import { decodeJwtPayload, isIdTokenFresh, tokensFromCognito } from "./tokens";

function fakeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "none", typ: "JWT" }));
  const body = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${header}.${body}.sig`;
}

describe("tokens", () => {
  it("decodes claims and builds AuthTokens from Cognito result", () => {
    const idToken = fakeJwt({ exp: 1_700_000_100, email: "a@example.com" });
    const tokens = tokensFromCognito({
      IdToken: idToken,
      AccessToken: "access",
      RefreshToken: "refresh",
    });
    expect(tokens.expiresAt).toBe(1_700_000_100);
    expect(decodeJwtPayload(tokens.idToken).email).toBe("a@example.com");
    expect(isIdTokenFresh(tokens, 1_700_000_000)).toBe(true);
    expect(isIdTokenFresh(tokens, 1_700_000_050)).toBe(false);
  });

  it("keeps previous refresh token on refresh response", () => {
    const idToken = fakeJwt({ exp: 99 });
    const tokens = tokensFromCognito(
      { IdToken: idToken, AccessToken: "access2" },
      "kept-refresh",
    );
    expect(tokens.refreshToken).toBe("kept-refresh");
  });
});
