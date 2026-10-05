# AWS デプロイとローカル起動（SAM）

Issue [#8](https://github.com/tag0203/kintore-memo/issues/8) の最小 IaC 骨格です。方針は [architecture-aws.md](./architecture-aws.md) が正です。

IaC は **AWS SAM** です（CDK にはしていません）。テンプレートは `infra/template.yaml`、本番 Lambda は Go の `api/` です。SPA はリポジトリ直下のままです。

## この骨格が立てるもの

| リソース | 内容 |
| --- | --- |
| S3 | SPA 用。パブリックアクセス遮断 |
| CloudFront + OAC | 非公開バケットを配信。403/404 → `index.html` |
| API Gateway HTTP API | JWT Authorizer 付き。`GET /api/health` だけ公開。他の `/api/*` は Authorizer 必須 |
| Lambda | Go（`provided.al2023`、#23）。Notion ラッパー（#10）と DayPlan の `GET` / `PUT`（#6）。`worker/` はデプロイしない |
| Cognito User Pool + App Client | JWT 発行。自己登録禁止（`AllowAdminCreateUserOnly`）。自前ログイン UI は [aws-auth.md](./aws-auth.md)（#9） |
| DynamoDB | オンデマンドの単一テーブル。`pk` / `sk` + TTL。エンティティは [dynamodb.md](./dynamodb.md) |
| SSM SecureString | Notion token / database id（名前と IAM はテンプレート。実体はデプロイ後に CLI で作成。CFN は SecureString を作れない） |
| CloudWatch Logs | Lambda ログ。保持 7 または 14 日（既定 14） |
| IAM | Lambda は対象テーブル・対象パラメータ・自ログだけ |

カスタムドメイン・ACM・DNS は [#13](https://github.com/tag0203/kintore-memo/issues/13) です。GitHub Actions の CI と OIDC の手順は [#14](https://github.com/tag0203/kintore-memo/issues/14) で、[github-actions-oidc.md](./github-actions-oidc.md) にあります。

## 前提ツール

- AWS CLI v2（デプロイするアカウントにサインイン済み）
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- Docker（`sam local` 用）
- Go 1.22（`sam build` が `api/` を `bootstrap` にコンパイルする。Lambda は `provided.al2023` / arm64）
- Node.js 22（ローカルの SPA。Lambda ランタイムではない）

リージョンの既定は `ap-northeast-1` です（`infra/samconfig.toml`）。

## ディレクトリ

```text
src/                    SPA（既存）
api/                    本番 Lambda（Go）。worker/ は本番経路ではない
worker/                 参考実装。本番経路にしない
infra/
  template.yaml         SAM テンプレート
  samconfig.toml        sam deploy の既定値
  github-oidc.yaml      Actions 用 OIDC ロール（bootstrap。Actions からは適用しない）
docs/
  architecture-aws.md
  aws-auth.md           Cognito ログイン（#9）
  aws-deploy.md         このファイル
  dynamodb.md           単一テーブル（#11）
  github-actions-oidc.md
.github/workflows/      CI と、手動の OIDC デプロイ
```

## デプロイ（1 環境）

秘密を git に置かないでください。SSM の値もリポジトリに書かないでください。

```bash
# 1. テンプレート検証
cd infra
sam validate --lint

# 2. ビルド（api/ の Go を bootstrap にまとめる）
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

既にある場合は `--overwrite` を付けます。Lambda はリクエストのたびにここを読み、同じ実行環境では数分間メモリに残します。値はレスポンスとログに出しません。

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
# {"ok":true,"service":"kintore-memo","stage":"dev","notionConfigured":true,"tableName":"kintore-memo-dev"}
```

`notionConfigured` は秘密の中身ではなく、トークンの置き場（環境変数か SSM 名）があることだけを示します。`/api/health` 以外は JWT が無いと 401 です。認証後の Notion ルートは、SSM に値があれば 200、設定が無ければ 500、Notion が拒否すれば 502 です。User Pool は自己登録を禁止しているので、利用するユーザーは管理者が `AdminCreateUser` で作ります。作成と自前ログインフォームの手順は [aws-auth.md](./aws-auth.md)（[#9](https://github.com/tag0203/kintore-memo/issues/9)）です。

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
    "NOTION_TOKEN": "YOUR_NOTION_TOKEN",
    "NOTION_DATABASE_ID": "YOUR_NOTION_DATABASE_ID",
    "NOTION_CACHE": "memory",
    "ALLOWED_ORIGIN": "http://localhost:5173",
    "ENVIRONMENT": "local"
  }
}
```

`NOTION_TOKEN` と `NOTION_DATABASE_ID` が両方あるときは SSM を呼びません。`sam local` には Cognito も DynamoDB も無いので、`NOTION_CACHE=memory` にします。このファイルは gitignore 済みです。値をリポジトリに書かないでください。SSM 名だけを渡しても、ローカルではパラメータを読めません。

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

## GitHub Actions

CI は pull request と `main` で毎回、テスト、型チェック、ビルド、`check:secrets`、`sam validate --lint`、`sam build` を実行します。AWS アカウントは要りません。

OIDC での `sam deploy` と S3 / CloudFront への公開は手動ワークフローです。ロール用のリポジトリ変数が空の間は成功のまま何もしません。アクセスキーは使いません。作成手順と権限は [github-actions-oidc.md](./github-actions-oidc.md) です。

## スコープ外（#8 ではやらない）

- Cognito ログイン UI とトークン付与 → [aws-auth.md](./aws-auth.md)（#9）
- 実アカウントでの DayPlan 疎通（実装は Go の `GET` / `PUT /api/day-plan` と `src/data/dayPlanClient.ts`。設計は [dynamodb.md](./dynamodb.md)）
- 画面の記録クライアント（#12。実装は `src/data/httpClient.ts`）
- カスタムドメイン / ACM / Cloudflare DNS（#13）
