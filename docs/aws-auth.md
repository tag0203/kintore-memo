# Cognito 認証（自前ログインフォーム）

Issue [#9](https://github.com/tag0203/kintore-memo/issues/9)。IaC の User Pool / App Client / JWT Authorizer は [#8](https://github.com/tag0203/kintore-memo/issues/8) の `infra/template.yaml` にあります。デプロイ手順は [aws-deploy.md](./aws-deploy.md) です。

方針は次のとおりです。

- **Hosted UI は使わない**。SPA の自前フォーム（メール＋パスワード）
- API Gateway HTTP API の **JWT Authorizer** が IdToken を検証する
- Lambda に独自認証は積まない
- 画面のデータ取得を本番 API に差し替えるのは [#12](https://github.com/tag0203/kintore-memo/issues/12)

## 前提

1. `sam deploy` 済み（スタック例: `kintore-memo-dev`）
2. Outputs に `UserPoolId` / `UserPoolClientId` / `HttpApiUrl` / `UserPoolIssuer` がある

```bash
STACK=kintore-memo-dev
aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId' || OutputKey=='UserPoolClientId' || OutputKey=='HttpApiUrl' || OutputKey=='UserPoolIssuer'].[OutputKey,OutputValue]" \
  --output table
```

## ユーザーを作る（CLI）

個人利用なのでコンソールサインアップは開きません。管理者が 1 ユーザーを作ります。

```bash
POOL_ID=$(aws cloudformation describe-stacks --stack-name kintore-memo-dev \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)

aws cognito-idp admin-create-user \
  --user-pool-id "$POOL_ID" \
  --username 'you@example.com' \
  --user-attributes Name=email,Value='you@example.com' Name=email_verified,Value=true \
  --temporary-password 'TempPass1a' \
  --message-action SUPPRESS
```

- 一時パスワードは自分だけが知る値にしてください（git や Issue に書かない）
- 初回ログイン時、画面が **新しいパスワードの設定** を求めます（Cognito の `NEW_PASSWORD_REQUIRED`）
- 恒久パスワードは User Pool の方針どおり **8 文字以上・大文字・小文字・数字**

パスワードを管理者が直接決めてしまう場合（学習用の短縮）:

```bash
aws cognito-idp admin-set-user-password \
  --user-pool-id "$POOL_ID" \
  --username 'you@example.com' \
  --password 'YourPass1a' \
  --permanent
```

この場合は初回のパスワード変更画面は出ません。

## フロントの環境変数

`.env`（gitignore 済み）に、Outputs の公開値だけを書きます。**Notion のトークンは書かない。**

```bash
# .env（コミットしない）
VITE_COGNITO_REGION=ap-northeast-1
VITE_COGNITO_USER_POOL_ID=ap-northeast-1_xxxxxxxx
VITE_COGNITO_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx
VITE_API_BASE_URL=https://xxxxxxxx.execute-api.ap-northeast-1.amazonaws.com/dev
```

```bash
npm run dev
```

- 3 つの `VITE_COGNITO_*` が揃っているときだけログイン画面が出ます
- 未設定のままだと従来どおりインメモリモックだけで動きます（トークン不要）
- `VITE_API_BASE_URL` は #12 の HTTP クライアント用。無くてもログイン自体は動きます

本番ビルド前にも同じ変数を渡します（値はビルド成果物に埋め込まれます。秘密ではない）。

## ログイン後のトークン

- 自前フォームが Cognito の `USER_PASSWORD_AUTH` で IdToken / AccessToken / RefreshToken を取る
- **API Gateway には IdToken** を `Authorization: Bearer …` で付ける（Authorizer の audience = App Client）
- トークンは `localStorage` の `kintore-memo.auth.v1` に保存。ログアウトで消す
- 期限切れ近くでは RefreshToken で IdToken を取り直す

`src/auth/authorizedFetch.ts` がその付与の薄いラッパです。`WorkoutLogClient` の差し替えはまだしません（#12）。

## curl で JWT 付き API を試す

`/api/health` は Authorizer なし。保護ルート（例: 未実装の `/api/exercises`）は JWT が無いと 401 です。

```bash
CLIENT_ID=$(aws cloudformation describe-stacks --stack-name kintore-memo-dev \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolClientId'].OutputValue" --output text)
API_URL=$(aws cloudformation describe-stacks --stack-name kintore-memo-dev \
  --query "Stacks[0].Outputs[?OutputKey=='HttpApiUrl'].OutputValue" --output text)

# 恒久パスワードが設定済みのユーザーで IdToken を取る
RESP=$(aws cognito-idp initiate-auth \
  --auth-flow USER_PASSWORD_AUTH \
  --client-id "$CLIENT_ID" \
  --auth-parameters USERNAME='you@example.com',PASSWORD='YourPass1a')

ID_TOKEN=$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["AuthenticationResult"]["IdToken"])')

curl -sS -o /dev/null -w "%{http_code}\n" "${API_URL}/api/exercises"
# 401

curl -sS -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer ${ID_TOKEN}" \
  "${API_URL}/api/exercises"
# 501（骨格 Lambda。実装は #10）— 401 ではないことがポイント
```

未認証が 401、認証後が 501（または #10 以降の 200）なら、JWT Authorizer は期待どおりです。

## ローカル SPA × デプロイ済み API

`infra/template.yaml` の CORS は CloudFront オリジンに加え `http://localhost:5173` と `http://localhost:4173` を許可しています。#12 で `authorizedFetch` から実 API を叩くときに使います。

`sam local` では Cognito Authorizer は効きません（[aws-deploy.md](./aws-deploy.md)）。

## スコープ外

- ソーシャルログイン
- Hosted UI / カスタムドメインの Cognito ドメイン
- `WorkoutLogClient` の HTTP 実装と画面の bootstrap（#12）
- ユーザーのセルフサインアップ UI
