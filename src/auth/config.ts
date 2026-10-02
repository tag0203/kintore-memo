export interface CognitoConfig {
  region: string;
  userPoolId: string;
  clientId: string;
  /** API Gateway ベース URL（末尾スラッシュなし）。#12 用。無くてもログインは動く */
  apiBaseUrl: string | null;
}

function trim(value: string | undefined): string {
  return (value ?? "").trim();
}

/** Cognito の公開設定が揃っていれば返す。揃っていなければ null（モックのみのローカル起動） */
export function readCognitoConfig(
  env: Pick<
    ImportMetaEnv,
    "VITE_COGNITO_REGION" | "VITE_COGNITO_USER_POOL_ID" | "VITE_COGNITO_CLIENT_ID" | "VITE_API_BASE_URL"
  > = import.meta.env,
): CognitoConfig | null {
  const region = trim(env.VITE_COGNITO_REGION);
  const userPoolId = trim(env.VITE_COGNITO_USER_POOL_ID);
  const clientId = trim(env.VITE_COGNITO_CLIENT_ID);
  const apiBaseUrl = trim(env.VITE_API_BASE_URL).replace(/\/+$/, "") || null;
  if (!region || !userPoolId || !clientId) return null;
  return { region, userPoolId, clientId, apiBaseUrl };
}

export function isAuthConfigured(
  env: Pick<ImportMetaEnv, "VITE_COGNITO_REGION" | "VITE_COGNITO_USER_POOL_ID" | "VITE_COGNITO_CLIENT_ID"> = import.meta
    .env,
): boolean {
  return readCognitoConfig(env) != null;
}
