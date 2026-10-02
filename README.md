# 筋トレメモ

前回の重量・回数・セット・きつさを見ながら、今日のトレーニングを1行ずつ残すための薄い Web アプリです。記録の置き場は Notion を想定しています。このリポジトリはローカルで画面を動かす土台で、デプロイはしていません。

本番は AWS に置きます。Cloudflare はドメインの DNS だけです。方針は [docs/architecture-aws.md](docs/architecture-aws.md) にまとめてあります。

## 画面

1. **今日のトレーニング** … 日付、任意の部位メモ、今日の種目。各種目に前回の `重量 × 回数 × セット` と、未 / 記録済。
2. **種目を追加** … 検索、最近使った種目、一覧、新しい種目名。
3. **記録** … 読み取り専用の「前回」と、前回の値を入れた「今日」。保存すると1行追加します。スキップは保存しません。

種目をタップすると記録画面へ進みます。保存後はホームで「記録済」になります。

## ローカルで起動する

```bash
npm install
npm run dev
```

ブラウザで <http://localhost:5173> を開きます。トークンは不要です。

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | 開発サーバ |
| `npm test` | 単体テストと、フロントにシークレットが無いことの確認 |
| `npm run typecheck` | 画面・設定・Worker の型チェック |
| `npm run build` | 静的ファイルを `dist/` へ出力（PWA のマニフェストと Service Worker を含む） |
| `npm run preview` | ビルド結果を <http://localhost:4173> で確認 |
| `npm run check:secrets` | ブラウザ側のソースと `dist/` に Notion のトークン類が無いことを確認 |

再読み込みするとモックの記録は初期データに戻ります。部位メモと「今日のメニュー」「終了」もメモリ上だけで、リロードで戻ります。

初期データは起動日を基準にしています。スクワットとレッグプレスは昨日の記録、レッグカールは今日も記録済み、です。

## データの境界

いま動く経路はインメモリのモックです。`worker/` の Notion 実装は参考で、本番経路ではありません。本番は API Gateway から Lambda へ進み、トークンは SSM に置きます。詳細は [docs/architecture-aws.md](docs/architecture-aws.md)。

```text
ブラウザ（React）
  WorkoutLogClient
    └─ インメモリのモック   ← いま動く経路。src/data/browserClient.ts

参考: Cloudflare Worker（本番では使わない）
  同じ WorkoutLogClient の形
    └─ Notion 実装         ← worker/notionClient.ts
         └─ Notion API 2026-03-11
```

画面は `src/data/client.ts` の `WorkoutLogClient` だけを見ます。Notion の URL やトークンを読むコードは `worker/` にしかありません。Vite は `VITE_` で始まる変数だけをブラウザへ埋め込みます。`.env.example` の `VITE_` は Cognito / API の公開設定だけです（秘密ではない）。Notion のキーには `VITE_` を付けません。

| 状態 | どこに置くか |
| --- | --- |
| 種目・重量・回数・セット数・きつさ・日付・タイトル | Notion の1行。保存のたびに追加（上書きしない） |
| 前回 | その種目で、今日より前の最新1行 |
| 今日のメニュー、部位メモ、終了 / 再開 | いまはブラウザのセッション。本番は DynamoDB（[#6](https://github.com/tag0203/kintore-memo/issues/6)、設計は [#11](https://github.com/tag0203/kintore-memo/issues/11)） |

モックの「最近」は、ピッカーで選んだ順です（初期並びは画面案に合わせています）。Worker 側の「最近」は、記録日が新しい順です。

## シークレット

- 本物のトークンやデータベース ID を git、フロントのソース、`VITE_` 変数、Issue に置かない。
- ローカル用の控えが要る場合も `.env` に書き、コミットしない（`.gitignore` 済み）。
- 本番では SSM Parameter Store の SecureString に置き、Lambda だけが読む。
- `worker/` は参考実装です。手元で試すときだけ、ファイルではなく Worker のシークレットにします。

```bash
npx wrangler secret put NOTION_TOKEN
npx wrangler secret put NOTION_DATABASE_ID
```

`.env.example` は空のプレースホルダだけです。

## Notion の形

データベースをインテグレーションに共有します。参考実装の `worker/` は API `2026-03-11` でデータベースを開き、先頭のデータソースを使います。プロパティ名は次の通りです。括弧は全角です。Lambda へ移植するときもこの列を使います。

| プロパティ | 型 | 内容 |
| --- | --- | --- |
| （タイトル列。名前はどれでもよい） | title | 保存時は「－」（全角ハイフン） |
| 種目 | select | 種目名。一覧はこの選択肢 |
| 重量（kg） | number | 重量 |
| 回数 | number | 回数 |
| セット数 | number | セット数 |
| きつさ | select | とても楽 / 楽 / ややきつい / きつい / とてもきつい |
| 日付 | date | その記録の日 |

新しい種目名は、最初の保存でセレクトの選択肢として足されます。それまで今日のメニューには載りますが、Notion には行がありません。

## AWS への次の段階

Pages にも Workers にも載せません。`worker/` と `wrangler.toml` は参考実装のまま残します。本番は CloudFront と S3、API Gateway、Lambda、Cognito、DynamoDB です。

方針は [docs/architecture-aws.md](docs/architecture-aws.md) です。最小の IaC（AWS SAM）は `infra/template.yaml` にあり、デプロイと `sam local` の手順は [docs/aws-deploy.md](docs/aws-deploy.md) です。

```bash
cd infra
sam validate --lint
sam build
sam deploy
```

Cognito の自前ログインとユーザー作成は [docs/aws-auth.md](docs/aws-auth.md)（[#9](https://github.com/tag0203/kintore-memo/issues/9)）です。`VITE_COGNITO_*` を `.env` に入れるとログイン画面が出ます。未設定なら従来どおりモックだけで動きます。

後続は Lambda の Notion API（[#10](https://github.com/tag0203/kintore-memo/issues/10)）、DynamoDB 設計（[#11](https://github.com/tag0203/kintore-memo/issues/11)）、画面の API 差し替え（[#12](https://github.com/tag0203/kintore-memo/issues/12)）です。
