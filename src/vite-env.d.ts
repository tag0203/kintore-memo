/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Cognito リージョン（例: ap-northeast-1）。未設定ならログイン画面は出さない */
  readonly VITE_COGNITO_REGION?: string;
  readonly VITE_COGNITO_USER_POOL_ID?: string;
  /** App Client ID。秘密ではない */
  readonly VITE_COGNITO_CLIENT_ID?: string;
  /** API Gateway のベース URL。記録の HTTP クライアントと DayPlan が使う。秘密ではない */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
