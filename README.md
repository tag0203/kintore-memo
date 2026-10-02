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

画面がいま呼ぶ経路はインメモリのモックです。本番の Notion アクセスは **API Gateway → Lambda（`backend/`）** だけで、ブラウザは Notion を直接呼びません。トークンは SSM SecureString です。詳細は [docs/architecture-aws.md](docs/architecture-aws.md)。

`worker/` と `wrangler.toml` は API の形と Notion マッピングの参考実装です。**本番経路にはしません。** Lambda は `worker/` を import せず、同じ形を `backend/` に持っています。

```text
ブラウザ（React）
  WorkoutLogClient
    └─ インメモリのモック   ← 画面がいま使う経路。src/data/browserClient.ts
         本番の差し替えは #12（セッション開始で bootstrap を取り、遷移はクライアントキャッシュ）

本番
  API Gateway（JWT Authorizer。Lambda はトークンを再検証しない）
    └─ Lambda backend/
         ├─ SSM SecureString（トークンとデータベース ID。メモリに短時間キャッシュ）
         ├─ Notion API 2026-03-11
         └─ 任意: DynamoDB NotionCache（300 秒。正データではない）

参考: Cloudflare Worker（デプロイしない）
  worker/notionClient.ts
```

画面は `src/data/client.ts` の `WorkoutLogClient` だけを見ます。Vite は `VITE_` で始まる変数だけをブラウザへ埋め込みます。`.env.example` の `VITE_` は Cognito / API の公開設定だけです（秘密ではない）。Notion のキーには `VITE_` を付けません。

### Lambda の API

`GET /api/health` だけ認証なしです。それ以外は API Gateway の JWT Authorizer が付いています。

| メソッド | 経路 | 内容 |
| --- | --- | --- |
| GET | `/api/health` | 死活。秘密は返さない |
| GET | `/api/exercises` | 種目一覧 |
| GET | `/api/exercises/recent` | 記録日が新しい順 |
| GET | `/api/logs/previous?exercise=&before=YYYY-MM-DD` | その日より前の最新 1 行 |
| GET | `/api/logs/today?exercise=&date=YYYY-MM-DD` | その日の最新 1 行 |
| GET | `/api/bootstrap?date=YYYY-MM-DD&exercise=` | 種目・最近・指定種目の前回と当日を一括。`exercise` は繰り返せる。`exercises=a,b` も可 |
| POST | `/api/logs` | 1 行追加。重量・回数・セット・きつさ・日付を検査してから Notion へ書く |

`date` は画面のセッション日付です。Lambda の UTC「今日」では上書きしません。

レート制限を避けるため、bootstrap と各 GET は同じ「最近の記録」ウィンドウを 300 秒キャッシュします。ウィンドウで前回が確定できない種目だけ、追加で 1 件問い合わせます。画面遷移のためには使いません。`POST /api/logs` のあと、種目一覧と最近ウィンドウとその種目のキャッシュを捨て、次の読みで Notion に戻ります。DynamoDB が使えないときはプロセス内メモリだけにします（`NOTION_CACHE=memory`）。キャッシュ項目は [docs/dynamodb.md](docs/dynamodb.md) の `NotionCache`（`pk=CACHE#notion`、セグメントを `#` で結んだ `sk`、TTL 300 秒）で、`backend/dynamodb.mjs` が組み立てます。

| 状態 | どこに置くか |
| --- | --- |
| 種目・重量・回数・セット数・きつさ・日付・タイトル | Notion の1行。保存のたびに追加（上書きしない） |
| 前回 | その種目で、今日より前の最新1行 |
| 今日のメニュー、部位メモ、終了 / 再開 | 本番は DynamoDB の DayPlan 1 項目（[docs/dynamodb.md](docs/dynamodb.md)、読み書きは [#6](https://github.com/tag0203/kintore-memo/issues/6)）。いま画面はブラウザのメモリ |

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

データベースをインテグレーションに共有します。`backend/`（本番）と参考実装の `worker/` は、どちらも API `2026-03-11` でデータベースを開き、先頭のデータソースを使います。プロパティ名は次の通りです。括弧は全角です。

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

Pages にも Workers にも載せません。`worker/` と `wrangler.toml` は参考実装のまま残し、本番経路には使いません。本番は CloudFront と S3、API Gateway、Lambda、Cognito、DynamoDB です。

方針は [docs/architecture-aws.md](docs/architecture-aws.md) です。最小の IaC（AWS SAM）は `infra/template.yaml` にあり、デプロイと `sam local` の手順は [docs/aws-deploy.md](docs/aws-deploy.md) です。

```bash
cd infra
sam validate --lint
sam build
sam deploy
```

Cognito の自前ログインとユーザー作成は [docs/aws-auth.md](docs/aws-auth.md)（[#9](https://github.com/tag0203/kintore-memo/issues/9)）です。`VITE_COGNITO_*` を `.env` に入れるとログイン画面が出ます。未設定なら従来どおりモックだけで動きます。

DynamoDB の単一テーブル（DayPlan と任意の Notion キャッシュ）は [docs/dynamodb.md](docs/dynamodb.md) です。Lambda の Notion API は `backend/` です（[#10](https://github.com/tag0203/kintore-memo/issues/10)）。残るのは今日のメニューの永続化（[#6](https://github.com/tag0203/kintore-memo/issues/6)）と、画面の API 差し替え（[#12](https://github.com/tag0203/kintore-memo/issues/12)）です。
