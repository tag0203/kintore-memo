import type { CognitoConfig } from "./config";
import { tokensFromCognito, type AuthTokens } from "./tokens";

interface CognitoErrorBody {
  __type?: string;
  message?: string;
}

export class CognitoAuthError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CognitoAuthError";
    this.code = code;
  }
}

export type SignInResult =
  | { kind: "tokens"; tokens: AuthTokens }
  | { kind: "newPasswordRequired"; session: string; email: string };

function endpoint(region: string): string {
  return `https://cognito-idp.${region}.amazonaws.com/`;
}

async function cognitoCall(region: string, target: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(endpoint(region), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  if (text) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new CognitoAuthError("ParseError", "Cognito の応答を読めませんでした");
    }
  }
  if (!response.ok) {
    const err = parsed as CognitoErrorBody;
    const code = (err.__type ?? "Unknown").split("#").pop() ?? "Unknown";
    throw new CognitoAuthError(code, humanizeCognitoError(code, err.message));
  }
  return parsed;
}

export function humanizeCognitoError(code: string, message?: string): string {
  switch (code) {
    case "NotAuthorizedException":
      return "メールアドレスまたはパスワードが違います";
    case "UserNotFoundException":
      return "メールアドレスまたはパスワードが違います";
    case "UserNotConfirmedException":
      return "ユーザーが未確認です。確認後に再度ログインしてください";
    case "PasswordResetRequiredException":
      return "パスワードのリセットが必要です";
    case "InvalidPasswordException":
      return "パスワードの条件を満たしていません（8文字以上、大文字・小文字・数字）";
    case "LimitExceededException":
    case "TooManyRequestsException":
      return "試行回数が多すぎます。しばらくしてから再度お試しください";
    case "ResourceNotFoundException":
      return "Cognito の設定（User Pool / App Client）を確認してください";
    default:
      return message?.trim() || `認証に失敗しました（${code}）`;
  }
}

/** 自前フォーム用。USER_PASSWORD_AUTH（App Client で有効済み） */
export async function signInWithPassword(
  config: CognitoConfig,
  email: string,
  password: string,
): Promise<SignInResult> {
  const data = await cognitoCall(config.region, "InitiateAuth", {
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: config.clientId,
    AuthParameters: {
      USERNAME: email.trim(),
      PASSWORD: password,
    },
  });

  if (data.ChallengeName === "NEW_PASSWORD_REQUIRED") {
    const session = data.Session;
    if (typeof session !== "string" || !session) {
      throw new CognitoAuthError("ChallengeError", "一時パスワードの更新セッションがありません");
    }
    return { kind: "newPasswordRequired", session, email: email.trim() };
  }

  const result = data.AuthenticationResult;
  if (!result || typeof result !== "object") {
    throw new CognitoAuthError("AuthResultMissing", "ログイン結果がありません");
  }
  return {
    kind: "tokens",
    tokens: tokensFromCognito(result as { IdToken?: string; AccessToken?: string; RefreshToken?: string }),
  };
}

/** admin-create-user の一時パスワード後に新しいパスワードを設定して完了する */
export async function completeNewPassword(
  config: CognitoConfig,
  email: string,
  newPassword: string,
  session: string,
): Promise<AuthTokens> {
  const data = await cognitoCall(config.region, "RespondToAuthChallenge", {
    ChallengeName: "NEW_PASSWORD_REQUIRED",
    ClientId: config.clientId,
    Session: session,
    ChallengeResponses: {
      USERNAME: email.trim(),
      NEW_PASSWORD: newPassword,
    },
  });
  const result = data.AuthenticationResult;
  if (!result || typeof result !== "object") {
    throw new CognitoAuthError("AuthResultMissing", "パスワード更新後のログイン結果がありません");
  }
  return tokensFromCognito(result as { IdToken?: string; AccessToken?: string; RefreshToken?: string });
}

export async function refreshAuthTokens(config: CognitoConfig, refreshToken: string): Promise<AuthTokens> {
  const data = await cognitoCall(config.region, "InitiateAuth", {
    AuthFlow: "REFRESH_TOKEN_AUTH",
    ClientId: config.clientId,
    AuthParameters: {
      REFRESH_TOKEN: refreshToken,
    },
  });
  const result = data.AuthenticationResult;
  if (!result || typeof result !== "object") {
    throw new CognitoAuthError("AuthResultMissing", "トークンの更新に失敗しました");
  }
  return tokensFromCognito(
    result as { IdToken?: string; AccessToken?: string; RefreshToken?: string },
    refreshToken,
  );
}
