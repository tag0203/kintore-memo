# GitHub Actions（CI と OIDC デプロイ）

Issue [#14](https://github.com/tag0203/kintore-memo/issues/14) の最初のスライスです。CI は pull request と `main` で毎回動きます。AWS へのデプロイは手動で、OIDC ロールが無い間は成功したまま何もしません。

長期のアクセスキー（`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`）は使いません。リポジトリの Secrets にも置きません。

## ワークフロー

| ファイル | いつ動くか | 内容 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | pull request、`main` への push、手動 | `npm test`、`npm run typecheck`、`npm run build`、`npm run check:secrets`、`go test`（Go 1.26）。`infra/template.yaml` があるとき `sam validate --lint` と `sam build`。OIDC 用テンプレートがあればそれも lint。Actions はフルコミット SHA 固定 |
| `.github/workflows/deploy.yml` | Actions タブからの手動実行だけ | 下の変数が空なら no-op。あるときだけ、**ビルドと AWS 資格情報をジョブ分離**したうえで `sam deploy` し、SPA を S3 に同期して CloudFront を無効化 |

デプロイは `main` からの実行だけがロールを引き受けます。pull request ではデプロイしません。OIDC の信頼条件は AWS がマップする `workflow` claim（workflow の `name:`。既定は `Deploy`）でも限定します。GitHub の JWT にある `workflow_ref`（ファイルパス）は AWS STS の condition key に出てこないので使いません。reusable workflow 向けの `job_workflow_ref` も、直接起動の Deploy には使いません。

本番 API は Go の `api/`（[#23](https://github.com/tag0203/kintore-memo/issues/23)）です。CI は `go test` と、そのバイナリを対象にした `sam build` を実行します。Cloudflare DNS（[#13](https://github.com/tag0203/kintore-memo/issues/13)）はこのワークフローの対象外です。

## Deploy ジョブの分離

| ジョブ | AWS / `id-token` | 内容 |
| --- | --- | --- |
| `gate` | なし | 変数と `refs/heads/main` を確認。未設定なら以降を skip |
| `build` | なし | `sam build`。成果物を artifact へ |
| `deploy-stack` | OIDC | 検証済み SAM 成果物を `sam deploy`。公開スタック出力だけを artifact へ |
| `build-spa` | なし | `npm ci` / `npm run build` / `check:secrets`（公開 Cognito・API URL のみ） |
| `publish-spa` | OIDC | `dist/` を S3 同期し CloudFront を無効化 |

`npm` の lifecycle やビルド依存が侵害されても、そのプロセスからは AWS 一時資格情報を読めません。ビルドを同じジョブの末尾へ移すだけでは不十分なため、資格情報付きジョブとは分けています。

## ログに出さないもの

- ワークフローは `set -x`、`sam --debug`、`aws --debug` を使いません。
- ロール ARN は形を確認したあとマスクします。一時クレデンシャルは `configure-aws-credentials` がマスクし、ステップ出力には出しません。
- ジョブ開始時にアクセスキー系の環境変数があると、引き受ける前に失敗します。
- デプロイロールは Notion 用 SSM パラメータの読み書きを明示的に拒否します。値は [aws-deploy.md](./aws-deploy.md) のとおり、手元の CLI で作ります。ワークフローはパラメータ名を解決しません。
- `npm run check:secrets` は (1) ブラウザ側と `dist/` にトークン名・ホストが無いこと、(2) **追跡ファイル全体**に Notion トークン値（`ntn_…` / `secret_…`）が無いことを見ます。漏れていたらファイルパスとパターン名だけを出し、一致した中身は出しません。

## 一度だけ用意する IAM

テンプレートは `infra/github-oidc.yaml` です。アプリの `template.yaml` とは別スタックです。Actions からは適用しません。アカウントに管理者としてサインインし、**ap-northeast-1** で実行します（ワークフローのリージョンと揃えます）。

**順序:** この OIDC ブートストラップを先に更新・適用してから、アプリの `sam deploy` を行ってください。アプリの API ロールは PermissionsBoundary `kintore-memo-api-permissions-boundary` を必須にします。境界ポリシーが無いとアプリスタックのロール作成・更新は失敗します。

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

加えて AWS がマップする `workflow` を次に固定します（`.github/workflows/deploy.yml` の `name: Deploy`）。

```text
Deploy
```

テンプレートの既定パラメータがこの値です。信頼は `StringEquals` でこの `sub`・`aud`・`workflow` だけです。pull request、他ブランチ、名前の違う workflow、GitHub Environment は一致しません。Environment を足すと `sub` が `repo:…:environment:名前` に変わるので、そのときはテンプレートを更新します。

`workflow` はファイルパスではなく表示名です。同じ名前の別 workflow を `main` に置けば理論上は一致します。パス単位で縛るなら、GitHub の OIDC `sub` カスタマイズで `workflow_ref` を `sub` に含め、信頼条件の `sub` で照合してください（AWS は `workflow_ref` を単独の condition key としては公開していません）。

名前だけの古い形式（`repo:tag0203/kintore-memo:ref:refs/heads/main`）では引き受けられません。

## 権限の範囲

ポリシーの実体は `infra/github-oidc.yaml` です。概要だけここに書きます。

| 許す | 範囲 |
| --- | --- |
| CloudFormation | スタック `kintore-memo-dev` / `staging` / `prod` と、SAM が成果物バケットに使う `aws-sam-cli-managed-default`。SAM Transform。`ValidateTemplate` のみリソース `*` |
| S3 | SPA バケット `kintore-memo-*-spa-<account>` と SAM 管理バケット。`ListAllMyBuckets` のみ `*`。ACL の付与はしない |
| Lambda / ログ | 関数名 `kintore-memo-*-api` と、そのロググループ。`logs:DescribeLogGroups` だけはリソースを指定できないので `*` |
| IAM | ロール `kintore-memo-*-api` の作成・更新は **PermissionsBoundary `kintore-memo-api-permissions-boundary` 付きに限定**。境界の削除は拒否。`iam:PassRole` は `lambda.amazonaws.com` だけ。API Gateway のサービスリンクロールを一度だけ作る権限 |
| DynamoDB | テーブル `kintore-memo-dev` / `staging` / `prod` |
| HTTP API | そのリージョンの `/apis` と `/tags` |
| Cognito | `CreateUserPool` はリソースを指定できないため `*`。ほかは user pool |
| CloudFront | ディストリビューションの作成は `*`。タグ付き作成 API は `CreateDistribution` と `TagResource`（作成時は id が無いので `*`）。取得・更新・無効化はアカウント内の distribution。OAC は origin access control |

意図的に外しているもの:

- アクセスキーの作成（明示的に拒否）
- Notion 用 SSM（`/kintore-memo/*/notion/*`）の読み書き（明示的に拒否）。ただし境界導入後も、正当な API ロール経由の Notion 読取は Lambda コード変更で間接利用され得る。デプロイ担当が SSM を直接読めないことと、Lambda が読めないことは別
- スタックの削除（`cloudformation:DeleteStack` は付けていません。削除は手元の管理者で行います）
- デプロイロール自身（`kintore-memo-gha-deploy`）の信頼ポリシー変更。管理できるロール名は `kintore-memo-*-api` だけです
- マネージドポリシーのアタッチ。Lambda の権限は `infra/template.yaml` のインラインポリシーのままにしてください
- API ロールへの `Action: '*'` 級の拡大。PermissionsBoundary がログ・DynamoDB アイテム・Notion SSM 読取・KMS（SSM経由）に上限を置く

`main` に入ったテンプレート変更は、このロールの範囲と境界の内側でそのまま適用されます。それは git に残る変更であり、アクセスキーを配ることではありません。

## GitHub 側で手動設定するもの（リポジトリ設定）

このリポジトリのコードだけでは Branch Protection / Rulesets / Environments は変わりません。公開リポジトリかつ個人利用でも、次を推奨します。

1. **`main` の Branch protection / Ruleset** … PR 必須、必須 CI（`CI` workflow）成功、管理者も含めて直 push 禁止、Rulesets で workflow / `infra/` 変更のレビューを強制できるならそうする
2. **GitHub Environment `prod`（任意）** … 必須 reviewer。入れる場合は OIDC の `sub` が `environment:prod` 形式になるので `infra/github-oidc.yaml` の信頼条件を同時更新し、Deploy の `prod` だけその Environment を `environment:` に指定する
3. **Actions の SHA pinning ポリシー** … 対応プランでは `sha_pinning_required` を有効化。ワークフローは既にフル SHA 固定
4. **Secret Scanning / Push Protection** … GitHub のリポジトリまたは org 設定で有効化（`check:secrets` の補完）

## デプロイの実行

変数を保存したあと、Actions の **Deploy** を `main` で手動実行します。入力は `dev` / `staging` / `prod`（既定 `dev`）です。

行うことは次のとおりです。

1. AWS 資格情報の無いジョブで `sam build` し、成果物を artifact にする
2. OIDC ジョブで `sam deploy`（変更セットの確認待ちはしない）。スタック名は `kintore-memo-<environment>`。初回も先にスタックを作る
3. 公開出力だけを次のジョブへ渡し、AWS 資格情報の無いジョブで `npm ci` / `npm run build` / `check:secrets` する
4. OIDC ジョブで `SpaBucketName` が `kintore-memo-<environment>-spa-<account>` のときだけ `aws s3 sync dist/` し、ディストリビューションを無効化する

`infra/samconfig.toml` の `confirm_changeset = true` は手元用です。ワークフローは `--no-confirm-changeset` で上書きします。

実アカウントがまだ無い状態では、変数を作らずにこのリポジトリをマージして構いません。CI は AWS なしで通り（`sam validate --lint` / `sam build` を含む）、Deploy は選んでも no-op です。
