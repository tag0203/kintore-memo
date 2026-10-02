# AWS デプロイとローカル起動（SAM）

Issue [#8](https://github.com/tag0203/kintore-memo/issues/8) の最小 IaC 骨格です。方針は [architecture-aws.md](./architecture-aws.md) が正です。

IaC は **AWS SAM** です（CDK にはしていません）。テンプレートは `infra/template.yaml`、Lambda の骨格は `backend/` です。SPA はリポジトリ直下のままです。

## この骨格が立てるもの

| リソース | 内容 |
| --- | --- |
| S3 | SPA 用。パブリックアクセス遮断 |
| CloudFront + OAC | 非公開バケットを配信。403/404 → `index.html` |
| API Gateway HTTP API | JWT Authorizer 付き。`GET /api/health` だけ公開 |
| Lambda | `/api/health` が応答。他の `/api/*` は 501（実装は #10） |
| Cognito User Pool + App Client | JWT 発行。自己登録禁止（`AllowAdminCreateUserOnly`）。自前ログイン UI は [aws-auth.md](./aws-auth.md)（#9） |
| DynamoDB | オンデマンドの単一テーブル。`pk` / `sk` + TTL。エンティティは [dynamodb.md](./dynamodb.md) |
| SSM SecureString | Notion token / database id（名前と IAM はテンプレート。実体はデプロイ後に CLI で作成。CFN は SecureString を作れない） |
| CloudWatch Logs | Lambda ログ。保持 7 または 14 日（既定 14） |
| IAM | Lambda は対象テーブル・対象パラメータ・自ログだけ |

カスタムドメイン・ACM・DNS は [#13](https://github.com/tag0203/kintore-memo/issues/13) です。GitHub Actions（OIDC）は [#14](https://github.com/tag0203/kintore-memo/issues/14) です。

## 前提ツール

- AWS CLI v2（デプロイするアカウントにサインイン済み）
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- Docker（`sam local` 用）
- Node.js 22（ローカルの SPA と Lambda ランタイムに合わせる）

リージョンの既定は `ap-northeast-1` です（`infra/samconfig.toml`）。

## ディレクトリ

```text
src/                    SPA（既存）
worker/                 参考実装。本番経路にしない
backend/                Lambda（骨格。Notion は #10）
infra/
  template.yaml         SAM テンプレート
  samconfig.toml        sam deploy の既定値
docs/
  architecture-aws.md
  aws-auth.md           Cognito ログイン（#9）
  aws-deploy.md         このファイル
  dynamodb.md           単一テーブル（#11）
```

## デプロイ（1 環境）

秘密を git に置かないでください。SSM の値もリポジトリに書かないでください。

```bash
# 1. テンプレート検証
cd infra
sam validate --lint

# 2. ビルド（backend/ を成果物にまとめる）
sam build

# 3. 初回 / 更新デプロイ（変更セット確認あり）
sam deploy
```

`sam deploy` は `samconfig.toml` の既定でスタック名 `kintore-memo-dev` を作ります。別環境にするときは例:

```bash
sam deploy \
  --stack-name kintore-memo-staging \
  --parameter-overrides ProjectName=kintore-memo Environment=staging LogRetentionDays=14
```

成功すると Outputs に次が出ます。

- `SpaUrl` / `CloudFrontDomainName` … SPA の URL
- `HttpApiUrl` … API のベース URL
- `UserPoolId` / `UserPoolClientId` … Cognito（フロントに出してよい）
- `AppTableName` … DynamoDB
- `NotionTokenParameterName` / `NotionDatabaseIdParameterName` … SSM 名

### デプロイ後に一度だけ（Notion 秘密）

CloudFormation は SSM の `SecureString` を作れません。パラメータ名と Lambda の `GetParameter` 権限だけをテンプレートに載せ、値は CLI で作ります（git に書かない）。

```bash
aws ssm put-parameter \
  --name /kintore-memo/dev/notion/token \
  --type SecureString \
  --value 'YOUR_NOTION_TOKEN'

aws ssm put-parameter \
  --name /kintore-memo/dev/notion/database-id \
  --type SecureString \
  --value 'YOUR_NOTION_DATABASE_ID'
```

既にある場合は `--overwrite` を付けます。骨格の Lambda はまだ SSM を読みません。#10 で読みます。

### SPA をバケットへ載せる（任意）

骨格だけなら空のバケットで構いません。画面を載せるとき（**リポジトリルート**で実行。直前の手順で `cd infra` している場合は先に戻る）:

```bash
cd ..   # infra/ にいる場合。成果物はリポジトリルートの dist/
npm run build
SPA_BUCKET=$(aws cloudformation describe-stacks \
  --stack-name kintore-memo-dev \
  --query "Stacks[0].Outputs[?OutputKey=='SpaBucketName'].OutputValue" \
  --output text)
DIST_ID=$(aws cloudformation describe-stacks \
  --stack-name kintore-memo-dev \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontDistributionId'].OutputValue" \
  --output text)

aws s3 sync dist/ "s3://${SPA_BUCKET}/" --delete
aws cloudfront create-invalidation --distribution-id "${DIST_ID}" --paths "/*"
```

### 疎通

```bash
API_URL=$(aws cloudformation describe-stacks \
  --stack-name kintore-memo-dev \
  --query "Stacks[0].Outputs[?OutputKey=='HttpApiUrl'].OutputValue" \
  --output text)

curl -sS "${API_URL}/api/health"
# {"ok":true,"service":"kintore-memo","stage":"skeleton",...}
```

`/api/health` 以外は JWT が無いと 401 です。User Pool は自己登録を禁止しているので、利用するユーザーは管理者が `AdminCreateUser` で作ります。作成と自前ログインフォームの手順は [aws-auth.md](./aws-auth.md)（[#9](https://github.com/tag0203/kintore-memo/issues/9)）です。

## ローカル（sam local）

AWS アカウント無しで API の形だけ試すときです。Cognito / 実 DynamoDB / 実 SSM は使えません。

```bash
cd infra
sam build
sam local start-api --port 3000
```

別ターミナル:

```bash
curl -sS http://127.0.0.1:3000/api/health
```

環境変数を渡す例:

```bash
sam local start-api --port 3000 \
  --env-vars env.json
```

`env.json` の例（コミットしない）:

```json
{
  "ApiFunction": {
    "TABLE_NAME": "kintore-memo-local",
    "NOTION_TOKEN_PARAM": "/kintore-memo/dev/notion/token",
    "NOTION_DATABASE_ID_PARAM": "/kintore-memo/dev/notion/database-id",
    "ALLOWED_ORIGIN": "http://localhost:5173",
    "ENVIRONMENT": "local"
  }
}
```

SPA のローカルは従来どおりです。

```bash
npm install
npm run dev
```

## 削除

学習用スタックを消すとき:

```bash
cd infra
sam delete --stack-name kintore-memo-dev
```

S3 にオブジェクトが残っているとバケット削除に失敗することがあります。先に空にしてください。

## スコープ外（#8 ではやらない）

- Cognito ログイン UI とトークン付与 → [aws-auth.md](./aws-auth.md)（#9）
- Notion ラッパー API の実装（#10）
- DynamoDB の読み書き API（設計は [dynamodb.md](./dynamodb.md)、永続化の実装は #6）
- 画面の API クライアント差し替え（#12）
- カスタムドメイン / ACM / Cloudflare DNS（#13）
- GitHub Actions OIDC（#14）
