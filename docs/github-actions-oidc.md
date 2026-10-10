# GitHub Actions（CI と OIDC デプロイ）

Issue [#14](https://github.com/tag0203/kintore-memo/issues/14) の最初のスライスです。CI は pull request と `main` で毎回動きます。`main` への push で CI が成功すると `dev` へ自動デプロイします。`staging` と `prod`、それに任意の再実行は手動です。OIDC ロールが無い間は、自動も手動も成功したまま何もしません。

長期のアクセスキー（`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`）は使いません。リポジトリの Secrets にも置きません。

## ワークフロー

| ファイル | いつ動くか | 内容 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | pull request、`main` への push、手動 | `npm test`、`npm run typecheck`、`npm run build`、`npm run check:secrets`、`go test`（Go 1.26）。`infra/template.yaml` があるとき `sam validate --lint` と `sam build`。OIDC 用テンプレートがあればそれも lint。Actions はフルコミット SHA 固定 |
| `.github/workflows/deploy.yml` | `main` への push で CI が成功したあと（自動は `dev` だけ）。Actions タブからの手動実行（`dev` / `staging` / `prod`） | 下の変数が空なら no-op。あるときだけ、**ビルドと AWS 資格情報をジョブ分離**したうえで `sam deploy` し、SPA を S3 に同期して CloudFront を無効化。自動実行は CI がテストした SHA を checkout する |

デプロイは `main` からの実行だけがロールを引き受けます。pull request ではデプロイしません。OIDC の信頼条件は AWS がマップする `workflow` claim（workflow の `name:`。既定は `Deploy`）でも限定します。GitHub の JWT にある `workflow_ref`（ファイルパス）は AWS STS の condition key に出てこないので使いません。reusable workflow 向けの `job_workflow_ref` も、直接起動の Deploy には使いません。

## main から dev への自動デプロイ

`deploy.yml` は CI（`.github/workflows/ci.yml` の `name: CI`）が完了した `workflow_run` でも動きます。条件は次のとおりです。

- 対象ブランチは `main`
- 起動元イベントは `push`（pull request や CI の手動実行ではデプロイしない）
- `github.event.workflow_run.conclusion == 'success'`
- 起動元の workflow 名は `CI`、workflow id は `372805829`（このリポジトリの `.github/workflows/ci.yml`）
- `path` は `.github/workflows/ci.yml`、またはその後ろに `@main` / `@refs/heads/main` / `@<40桁の sha>` が付いた形。Workflow Run の REST 例は `.github/workflows/build.yml@main` で、このリポジトリの現行レスポンスは接尾辞なし。ファイル部分と ref を分けて見る
- `head_repository` の full name と id が、実行中のリポジトリかつ id `1389679197` と一致すること。fork の head は拒否する
- デプロイ先は `dev` 固定。`staging` / `prod` は手動の `workflow_dispatch` だけ

`test` workflow（`test.yml`）は待ちません。中身は `npm test`、`go test`、Lambda バイナリのコンパイルで、CI の app ジョブがそれに加えて型チェック、ビルド、`check:secrets`、SAM の validate / build を実行します。`workflow_run` は列挙した workflow のどれか一つが完了すると起動するので、両方を書くと片方が成功しただけでデプロイします。完了順のずれを API で突き合わせる方式は使っていません。

checkout するコミットは `github.event.workflow_run.head_sha` です。`workflow_run` の `github.sha` はデフォルトブランチの先端であり、テストしたコミットとは限りません。

同じ環境へのデプロイは concurrency group `deploy-<environment>` で重ねません。進行中のデプロイはキャンセルしません。GitHub はこのグループの待ちを 1 本だけ残し、新しい run が待ちの run を置き換えます。置き換えられた run のアプリケーション変更は、実行される run が最後の成功デプロイとの差分で見るので、デプロイから落ちません。自動実行は手動の `dev` と同じ `deploy-dev` に入ります。`staging` と `prod` の手動実行は別グループのままです。

`workflow_run` には `paths` フィルタがありません。gate は、GitHub Deployments の environment `dev` で最後に成功したデプロイの SHA から、テストした tip までの差分を見ます。push の `before` は使いません。CI がキャンセルされたり、`deploy-dev` の待ちが 1 本に置き換わったりしても、実行される run は未デプロイのアプリケーション変更を含んだ木をデプロイします。

成功した `dev` の publish のあと、`record-dev-deployment` が同じ SHA で deployment を作り、status を `success` にします。このジョブに AWS 資格情報はありません。手動の `dev` も記録します。`staging` と `prod` は記録しません。これは `GITHUB_TOKEN` の `deployments: read` / `deployments: write` であり、OIDC ロールの権限は変わりません。

- その範囲の変更が `docs/` 以下（ディレクトリ名は大文字小文字を区別する）と、拡張子 `.md` / `.markdown`（拡張子は区別しない）だけ、または差分が空なら、自動デプロイしません。ドキュメントだけの push でも CI 自体は動きます
- 成功記録が無い、API が読めない、SHA がリポジトリに無い、テストした SHA の祖先でないときは、範囲が分からないので tip をデプロイします
- テストしたコミットより新しいコミットがアプリケーションファイルを変えているときは、古い SHA をデプロイしません。遅い run が新しい `dev` を巻き戻さないためです。新しい方の CI が成功したときに、その SHA をデプロイします
- 新しいコミットがドキュメントだけなら、テスト済みのアプリケーション SHA をデプロイします。そのドキュメントコミットの run が先に実行された場合も、最後の成功デプロイ以降にアプリケーション変更があれば、その tip をデプロイします
- 判定できない SHA（`main` の first-parent に無い、など）はデプロイしません。手動の `workflow_dispatch` はこの判定をしません

### 自動デプロイを一時的に止める

リポジトリ変数 `AUTO_DEPLOY_DEV` を `false` にします。Settings → Secrets and variables → Actions → Variables です。未設定または `true` のときは自動デプロイします。それ以外の値は打ち間違いとみなし、gate が失敗します。

この変数は自動実行だけを止めます。Actions タブからの手動 Deploy は今までどおりです。workflow 全体を無効にすると手動実行も止まるので、一時停止には使いません。再開するときは変数を `true` にするか、削除します。

本番 API は Go の `api/`（[#23](https://github.com/tag0203/kintore-memo/issues/23)）です。CI は `go test` と、そのバイナリを対象にした `sam build` を実行します。Cloudflare DNS（[#13](https://github.com/tag0203/kintore-memo/issues/13)）はこのワークフローの対象外です。

## Deploy ジョブの分離

| ジョブ | AWS / `id-token` | 内容 |
| --- | --- | --- |
| `gate` | なし（`deployments: read`） | 変数と `refs/heads/main` を確認。未設定なら以降を skip。自動実行では `AUTO_DEPLOY_DEV` と、最後に成功した dev デプロイ以降にアプリケーション変更があるかも見る |
| `build` | なし | `sam build`。成果物を artifact へ |
| `deploy-stack` | OIDC | 検証済み SAM 成果物を `sam deploy`。公開スタック出力だけを artifact へ |
| `build-spa` | なし | `npm ci` / `npm run build` / `check:secrets`（公開 Cognito・API URL のみ） |
| `publish-spa` | OIDC | `dist/` を S3 同期し CloudFront を無効化 |
| `record-dev-deployment` | なし（`deployments: write`） | `dev` の publish 成功後に、その SHA を GitHub Deployments の environment `dev` へ記録する。`staging` / `prod` では動かない |

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

自動デプロイの `workflow_run` でも、この信頼のままで引き受けられます。このイベントはデフォルトブランチ（`main`）で動き、OIDC トークンを要求するのは引き続き `name: Deploy` の workflow です。そのため `sub` は上の `ref:refs/heads/main`、`workflow` は `Deploy` のままです。`event_name` は `workflow_run` になりますが、信頼条件は `event_name` を見ていません。reusable workflow ではないので `job_workflow_ref` は `deploy.yml@refs/heads/main` であり、条件には使っていません。

CI から `workflow_call` で Deploy を呼ぶ方式にはしていません。その場合 AWS が見る `workflow` は呼び出し元の `CI` になり、信頼の更新と、CI という名前の workflow からの引き受けが必要になります。`infra/github-oidc.yaml` は変えていないので、この変更のために OIDC スタックを再適用する必要はありません。

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

`AWS_DEPLOY_ROLE_ARN` を保存したあと、`main` への push で CI が成功すると `dev` は自動でデプロイされます。ロール変数が空の間は、その実行も成功のまま何もしません。

`staging` / `prod`、または `dev` の再実行は、Actions の **Deploy** を `main` で手動実行します。入力は `dev` / `staging` / `prod`（既定 `dev`）です。手動実行は `AUTO_DEPLOY_DEV` の影響を受けません。

行うことは次のとおりです。

1. AWS 資格情報の無いジョブで `sam build` し、成果物を artifact にする
2. OIDC ジョブで `sam deploy`（変更セットの確認待ちはしない）。スタック名は `kintore-memo-<environment>`。初回も先にスタックを作る
3. 公開出力だけを次のジョブへ渡し、AWS 資格情報の無いジョブで `npm ci` / `npm run build` / `check:secrets` する
4. OIDC ジョブで `SpaBucketName` が `kintore-memo-<environment>-spa-<account>` のときだけ `aws s3 sync dist/` し、ディストリビューションを無効化する

`infra/samconfig.toml` の `confirm_changeset = true` は手元用です。ワークフローは `--no-confirm-changeset` で上書きします。

実アカウントがまだ無い状態では、変数を作らずにこのリポジトリをマージして構いません。CI は AWS なしで通り（`sam validate --lint` / `sam build` を含む）、Deploy は選んでも no-op です。
