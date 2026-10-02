export interface AuthTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  /** Unix 秒。IdToken の exp */
  expiresAt: number;
}

export interface JwtClaims {
  exp?: number;
  email?: string;
  "cognito:username"?: string;
  sub?: string;
}

/** 署名検証はしない。期限切れ判定と表示用だけ */
export function decodeJwtPayload(token: string): JwtClaims {
  const parts = token.split(".");
  if (parts.length < 2) throw new Error("JWT の形が不正です");
  const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  const json = atob(padded);
  return JSON.parse(json) as JwtClaims;
}

export function tokensFromCognito(result: {
  IdToken?: string;
  AccessToken?: string;
  RefreshToken?: string;
}, previousRefresh?: string): AuthTokens {
  const idToken = result.IdToken;
  const accessToken = result.AccessToken;
  const refreshToken = result.RefreshToken ?? previousRefresh;
  if (!idToken || !accessToken || !refreshToken) {
    throw new Error("Cognito のトークンが不足しています");
  }
  const claims = decodeJwtPayload(idToken);
  if (typeof claims.exp !== "number") throw new Error("IdToken に exp がありません");
  return { idToken, accessToken, refreshToken, expiresAt: claims.exp };
}

/** 期限の 60 秒前から更新対象にする */
export function isIdTokenFresh(tokens: AuthTokens, nowSec = Math.floor(Date.now() / 1000)): boolean {
  return tokens.expiresAt - 60 > nowSec;
}

export function displayEmailFromIdToken(idToken: string): string {
  const claims = decodeJwtPayload(idToken);
  return claims.email ?? claims["cognito:username"] ?? claims.sub ?? "";
}
