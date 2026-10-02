# GitHub Actions（CI と OIDC デプロイ）

Issue [#14](https://github.com/tag0203/kintore-memo/issues/14) の最初のスライスです。CI は pull request と `main` で毎回動きます。AWS へのデプロイは手動で、OIDC ロールが無い間は成功したまま何もしません。

長期のアクセスキー（`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`）は使いません。リポジトリの Secrets にも置きません。

## ワークフロー

| ファイル | いつ動くか | 内容 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | pull request、`main` への push、手動 | `npm test`（画面・参考 Worker・`backend/`）、`npm run typecheck`、`npm run build`、`npm run check:secrets`（ビルド後にも実行）。`infra/template.yaml` があるとき `sam validate --lint` と `sam build`。OIDC 用テンプレートがあればそれも lint |
| `.github/workflows/deploy.yml` | Actions タブからの手動実行だけ | 下の変数が空なら no-op。あるときだけ OIDC で `sam deploy` し、SPA を S3 に同期して CloudFront を無効化 |

デプロイは `main` からの実行だけがロールを引き受けます。pull request ではデプロイしません。

Go への書き換え（[#23](https://github.com/tag0203/kintore-memo/issues/23)）と Cloudflare DNS（[#13](https://github.com/tag0203/kintore-memo/issues/13)）はこのワークフローの対象外です。API はいまの `backend/`（Node）のままです。

## ログに出さないもの

- ワークフローは `set -x`、`sam --debug`、`aws --debug` を使いません。
- ロール ARN は形を確認したあとマスクします。一時クレデンシャルは `configure-aws-credentials` がマスクし、ステップ出力には出しません。
- ジョブ開始時にアクセスキー系の環境変数があると、引き受ける前に失敗します。
- デプロイロールは Notion 用 SSM パラメータの読み書きを明示的に拒否します。値は [aws-deploy.md](./aws-deploy.md) のとおり、手元の CLI で作ります。ワークフローはパラメータ名を解決しません。
- `npm run check:secrets` はブラウザ側と `dist/` にトークンが無いことを見ます。漏れていたらファイルパスとパターン名だけを出し、一致した中身は出しません。

## 一度だけ用意する IAM

テンプレートは `infra/github-oidc.yaml` です。アプリの `template.yaml` とは別スタックです。Actions からは適用しません。アカウントに管理者としてサインインし、**ap-northeast-1** で実行します（ワークフローのリージョンと揃えます）。

```bash
aws cloudformation deploy \
  --template-file infra/github-oidc.yaml \
  --stack-name kintore-memo-github-oidc \
  --region ap-northeast-1 \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset
```

同じ URL の OIDC プロバイダがアカウントに既にあるときは、プロバイダを二重に作れません。その ARN を渡します。

```bash
aws cloudformation deploy \
  --template-file infra/github-oidc.yaml \
  --stack-name kintore-memo-github-oidc \
  --region ap-northeast-1 \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    CreateOidcProvider=false \
    ExistingOidcProviderArn=arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com
```

成功したら、出力 `DeployRoleArn` を控えます。git には書きません。

```bash
aws cloudformation describe-stacks \
  --stack-name kintore-memo-github-oidc \
  --region ap-northeast-1 \
  --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArn'].OutputValue" \
  --output text
```

GitHub の **Settings → Secrets and variables → Actions → Variables** に、名前 `AWS_DEPLOY_ROLE_ARN` でその ARN を追加します。Secrets には置きません。変数が無い、または空のとき、Deploy ワークフローは AWS を呼ばずに成功します。

## 信頼ポリシー

プロバイダ URL は `https://token.actions.githubusercontent.com`、audience は `sts.amazonaws.com` です。証明書の thumbprint はテンプレートに書きません。IAM が CA から取得します。

このリポジトリは 2026-09-26 作成なので、OIDC の `sub` は不変 ID 付きです。確認:

```bash
gh api repos/tag0203/kintore-memo/actions/oidc/customization/sub
```

現在の prefix は `repo:tag0203@20207728/kintore-memo@1389679197` です。`main` で Deploy を実行したときの `sub` は次です。

```text
repo:tag0203@20207728/kintore-memo@1389679197:ref:refs/heads/main
```

テンプレートの既定パラメータがこの値です。信頼は `StringEquals` でこの `sub` と `aud` だけです。pull request、他ブランチ、GitHub Environment は一致しません。Environment を足すと `sub` が `repo:…:environment:名前` に変わるので、そのときはテンプレートを更新します。

名前だけの古い形式（`repo:tag0203/kintore-memo:ref:refs/heads/main`）では引き受けられません。

## 権限の範囲

ポリシーの実体は `infra/github-oidc.yaml` です。概要だけここに書きます。

| 許す | 範囲 |
| --- | --- |
| CloudFormation | スタック `kintore-memo-dev` / `staging` / `prod` と、SAM が成果物バケットに使う `aws-sam-cli-managed-default`。SAM Transform。`ValidateTemplate` のみリソース `*` |
| S3 | SPA バケット `kintore-memo-*-spa-<account>` と SAM 管理バケット。`ListAllMyBuckets` のみ `*`。ACL の付与はしない |
| Lambda / ログ | 関数名 `kintore-memo-*-api` と、そのロググループ |
| IAM | ロール `kintore-memo-*-api` の作成とインラインポリシー、`iam:PassRole` は `lambda.amazonaws.com` だけ。API Gateway のサービスリンクロールを一度だけ作る権限 |
| DynamoDB | テーブル `kintore-memo-dev` / `staging` / `prod` |
| HTTP API | そのリージョンの `/apis` と `/tags` |
| Cognito | `CreateUserPool` はリソースを指定できないため `*`。ほかは user pool |
| CloudFront | ディストリビューションの作成は `*`。取得・更新・無効化はアカウント内の distribution。OAC は origin access control |

意図的に外しているもの:

- アクセスキーの作成（明示的に拒否）
- Notion 用 SSM（`/kintore-memo/*/notion/*`）の読み書き（明示的に拒否）
- スタックの削除（`cloudformation:DeleteStack` は付けていません。削除は手元の管理者で行います）
- デプロイロール自身（`kintore-memo-gha-deploy`）の信頼ポリシー変更。管理できるロール名は `kintore-memo-*-api` だけです
- マネージドポリシーのアタッチ。Lambda の権限は `infra/template.yaml` のインラインポリシーのままにしてください

`main` に入ったテンプレート変更は、このロールの範囲でそのまま適用されます。Lambda ロールの中身を広げる変更もデプロイとして通ります。それは git に残る変更であり、アクセスキーを配ることではありません。

## デプロイの実行

変数を保存したあと、Actions の **Deploy** を `main` で手動実行します。入力は `dev` / `staging` / `prod`（既定 `dev`）です。

行うことは次のとおりです。

1. 画面を `npm run build` し、`npm run check:secrets` で `dist/` を見る
2. `sam build` してから `sam deploy`（変更セットの確認待ちはしない）。スタック名は `kintore-memo-<environment>`
3. 出力 `SpaBucketName` が `kintore-memo-<environment>-spa-<account>` のときだけ `aws s3 sync dist/` する
4. 出力のディストリビューション ID に対して `/*` を無効化する

`infra/samconfig.toml` の `confirm_changeset = true` は手元用です。ワークフローは `--no-confirm-changeset` で上書きします。

実アカウントがまだ無い状態では、変数を作らずにこのリポジトリをマージして構いません。CI は AWS なしで通り、Deploy は選んでも no-op です。
