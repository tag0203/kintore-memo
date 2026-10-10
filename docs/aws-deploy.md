# AWS デプロイとローカル起動（SAM）

Issue [#8](https://github.com/tag0203/kintore-memo/issues/8) の最小 IaC 骨格です。方針は [architecture-aws.md](./architecture-aws.md) が正です。

IaC は **AWS SAM** です（CDK にはしていません）。テンプレートは `infra/template.yaml`、本番 Lambda は Go の `api/` です。SPA はリポジトリ直下のままです。

## この骨格が立てるもの

| リソース | 内容 |
| --- | --- |
| S3 | SPA 用。パブリックアクセス遮断 |
| CloudFront + OAC | 非公開バケットを配信。403/404 → `index.html` |
| API Gateway HTTP API | JWT Authorizer 付き。`GET /api/health` だけ公開。他の `GET` / `POST` / `PUT /api/*` は Authorizer 必須。`OPTIONS` はルートにせず、`CorsConfiguration` が preflight に答える。全ルートのスロットリングは持続 10 rps、バースト 20。アクセスログは下のロググループ |
| Lambda | Go（`provided.al2023`、#23）。Notion ラッパー（#10）と DayPlan の `GET` / `PUT`（#6）。`worker/` はデプロイしない。予約同時実行は既定で未設定（`ReservedConcurrency=0`） |
| Cognito User Pool + App Client | JWT 発行。自己登録禁止（`AllowAdminCreateUserOnly`）。自前ログイン UI は [aws-auth.md](./aws-auth.md)（#9） |
| DynamoDB | オンデマンドの単一テーブル。`pk` / `sk` + TTL。エンティティは [dynamodb.md](./dynamodb.md) |
| SSM SecureString | Notion token / database id（名前と IAM はテンプレート。実体はデプロイ後に CLI で作成。CFN は SecureString を作れない） |
| CloudWatch Logs | Lambda ログは保持 7 または 14 日（既定 14）。HTTP API のアクセスログは `/aws/apigateway/kintore-memo-<environment>-http` で、保持は 14 日固定 |
| IAM | Lambda は対象テーブル・対象パラメータ・自ログだけ |

カスタムドメイン・ACM・DNS は [#13](https://github.com/tag0203/kintore-memo/issues/13) です。GitHub Actions の CI と OIDC の手順は [#14](https://github.com/tag0203/kintore-memo/issues/14) で、[github-actions-oidc.md](./github-actions-oidc.md) にあります。

## 前提ツール

- AWS CLI v2（デプロイするアカウントにサインイン済み）
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- Docker（`sam local` 用）
- Go 1.26（`sam build` が `api/` を `bootstrap` にコンパイルする。Lambda は `provided.al2023` / arm64）
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
  github-oidc.yaml      Actions 用 OIDC ロールと API 用 PermissionsBoundary（bootstrap。Actions からは適用しない）
docs/
  architecture-aws.md
  aws-auth.md           Cognito ログイン（#9）
  aws-deploy.md         このファイル
  dynamodb.md           単一テーブル（#11）
  github-actions-oidc.md
.github/workflows/      CI と、OIDC デプロイ（main の CI 成功後に dev、ほかは手動）
```

## デプロイ（1 環境）

秘密を git に置かないでください。SSM の値もリポジトリに書かないでください。

API ロールは PermissionsBoundary（OIDC ブートストラップが作る `kintore-memo-api-permissions-boundary`）必須です。まだなら先に [github-actions-oidc.md](./github-actions-oidc.md) の手順で `infra/github-oidc.yaml` を適用してください。

```bash
# 1. テンプレート検証
cd infra
sam validate --lint

# 2. ビルド（api/ の Go を bootstrap にまとめる）
sam build

# 3. 初回 / 更新デプロイ（変更セット確認あり）
sam deploy
```

`sam deploy` は `samconfig.toml` の既定でスタック名 `kintore-memo-dev` を作ります。API の CORS に載せる CloudFront オリジンはパラメータ `SpaAllowedOrigin` です（`https://` + `CloudFrontDomainName`）。ディストリビューションを `GetAtt` しないのは、CSP がこの API を参照し、ディストリビューションがそのポリシーを参照するためです。既にあるスタックへ手元で出すときは、空のままにすると CORS からそのオリジンが外れます。Actions の Deploy は出力をログに出さず、この値を渡します。初回作成でドメインがまだ無いときだけ空で一度出し、ドメインが出来てからもう一度出します。

別環境にするときは例:

```bash
sam deploy \
  --stack-name kintore-memo-staging \
  --parameter-overrides ProjectName=kintore-memo Environment=staging LogRetentionDays=14 ReservedConcurrency=0
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
# {"ok":true}
```

`/api/health` の本文は `{"ok":true}` だけです。ステージ名、テーブル名、Notion の設定有無は返しません。`/api/health` 以外は JWT が無いと 401 です。認証後の Notion ルートは、SSM に値があれば 200、設定が無ければ 500、Notion が拒否すれば 502 です。500 と 502 の本文は固定の日本語と API Gateway の `requestId` だけで、Notion や AWS の生エラーは返しません。UUID は応答に入れず、Lambda のリクエスト ID は CloudWatch に残します。User Pool は自己登録を禁止しているので、利用するユーザーは管理者が `AdminCreateUser` で作ります。作成と自前ログインフォームの手順は [aws-auth.md](./aws-auth.md)（[#9](https://github.com/tag0203/kintore-memo/issues/9)）です。

## API の上限とアクセスログ

### スロットリング

`HttpApi` の `DefaultRouteSettings` は、認証の有無にかかわらず全ルートに持続 10 リクエスト/秒、バースト 20 をかけます。超えた分は API Gateway が 429 にし、Lambda は起動しません。個人利用の画面操作には十分で、認証なしの `/api/health` を連打されたときの課金はここで止まります。

### 予約同時実行は既定で付けない

パラメータ `ReservedConcurrency` が `0` または空のとき、Lambda の `ReservedConcurrentExecutions` はテンプレートに出しません（`AWS::NoValue`）。`2` / `3` / `4` / `5` のときだけ、その数を予約します。

既定を未設定にした理由は、新規アカウントでは予約するとデプロイが失敗することがあるためです。2026-10 の project サインアップで作ったアカウントのように、Lambda のアカウント同時実行クォータが 10 のことがあります。AWS は未予約同時実行を 10 未満にする予約を拒否します。未予約はアカウント上限そのものではなく、他の関数がすでに予約した分を引いた残りです。上限が 10 で他に予約が無いとき、2 を予約すると未予約は 8 になり、`UnreservedConcurrentExecution below its minimum value of [10]` でスタック更新が失敗します。失敗する値は既定にできません。スロットリングは予約が無くても効きます。

有効にする前に、同じリージョンで未予約枠を確認します。

```bash
aws lambda get-account-settings --region ap-northeast-1
```

見るのは `AccountLimit.UnreservedConcurrentExecutions` です。`ConcurrentExecutions`（アカウント合計）から引くだけでは、他の関数の予約を見落とします。

この関数に今予約が無いとき（既定）、N（2〜5）を付けてよいのは `UnreservedConcurrentExecutions - N` が 10 以上のときだけです。すでにこの関数が R を予約しているときは、付け替えで R が未予約へ戻ってから N を取るので、`UnreservedConcurrentExecutions + R - N` が 10 以上であることを確認します。R は次で見ます。予約が無いと `ReservedConcurrentExecutions` は返らず、そのときは R は 0 です。

```bash
aws lambda get-function-concurrency \
  --function-name kintore-memo-dev-api \
  --region ap-northeast-1
```

`staging` / `prod` は関数名の `dev` をその環境に置き換えます。未予約が足りないときは、Service Quotas で Lambda の Concurrent executions を上げてからにします。

ワークフロー `.github/workflows/deploy.yml` と手元用 `infra/samconfig.toml` は `ReservedConcurrency=0` を渡します。上げるときは両方の `0` を `2`〜`5` に変えます。デプロイロールには `lambda:PutFunctionConcurrency` と `lambda:DeleteFunctionConcurrency` を付けてあります。値を変えるだけなら、OIDC スタックの再適用は要りません。自動デプロイは `0` を明示するので、手元の `sam deploy` だけで上げても、次の `dev` デプロイで未設定に戻ります。残すならワークフローの値を変えてマージします。

### アクセスログ

ステージの `AccessLogSettings` は、ロググループ `/aws/apigateway/kintore-memo-<environment>-http` に JSON を出します。保持は 14 日です。Lambda ログの `LogRetentionDays`（7 または 14）とは別に固定しています。

項目は `requestId`、`ip`（`$context.identity.sourceIp`）、`requestTime`、`httpMethod`、`routeKey`、`status`、`responseLength`、`integrationErrorMessage`、`authorizerError`（`$context.authorizer.error`）です。

書かないものは、`Authorization` ヘッダー、`$request.header.*`、JWT のクレームです。`sub` も書きません。認証失敗は `authorizerError` で足り、成功した呼び出しをユーザーに結び付ける識別子はアクセスログに残しません。IP は不正アクセスの追跡のために入れます。メールアドレスやトークンは入りません。実行ログ（`LoggingLevel`）と `DataTraceEnabled` は付けていません。

API Gateway がログ配信を作るとき、ロググループのリソースポリシーも作ります。テンプレートに `AWS::Logs::ResourcePolicy` は置いていません。デプロイロールに必要な `logs:CreateLogDelivery` などの追加と、マージ前のスタック更新は [github-actions-oidc.md](./github-actions-oidc.md) です。ステージ自体の更新は、既存の `apigateway:PATCH` / `PUT`（`/apis/*`）で足ります。

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

`main` への push でその CI が成功すると、OIDC で `dev` に `sam deploy` し、S3 / CloudFront へ公開します。checkout するのは CI がテストしたコミットです。`staging` と `prod` は Actions の Deploy を手動実行します。ロール ARN の Secret `AWS_DEPLOY_ROLE_ARN` が空の間は、自動も手動も成功のまま何もしません。アクセスキーは使いません。

最後に成功した `dev` デプロイ以降がドキュメントと Markdown だけのときは、自動デプロイをスキップします。それより前のアプリケーション変更がまだデプロイされていなければ、テストした tip をデプロイします。より新しいアプリケーションコミットの CI が失敗しているときは、テスト済みの古い SHA をデプロイします。新しい CI が成功しているときと、そのコミットがすでに `dev` にあるときだけ、古い SHA は出しません。自動デプロイだけを止めるときは、リポジトリ変数 `AUTO_DEPLOY_DEV` を `false` にします。手動実行は残ります。作成手順、権限、OIDC の信頼は [github-actions-oidc.md](./github-actions-oidc.md) です。自動デプロイの仕組み自体に OIDC の再適用は要りません。アクセスログ、予約同時実行、CloudFront のレスポンスヘッダーポリシーの権限を足したときは、同ドキュメントの手順でマージ前にスタックを更新します。アクセスログ用に更新済みでも、レスポンスヘッダーポリシーの権限は別なので、その変更を含むツリーでもう一度適用します。

## スコープ外（#8 ではやらない）

- Cognito ログイン UI とトークン付与 → [aws-auth.md](./aws-auth.md)（#9）
- 実アカウントでの DayPlan 疎通（実装は Go の `GET` / `PUT /api/day-plan` と `src/data/dayPlanClient.ts`。設計は [dynamodb.md](./dynamodb.md)）
- 画面の記録クライアント（#12。実装は `src/data/httpClient.ts`）
- カスタムドメイン / ACM / Cloudflare DNS（#13）
