# 筋トレメモ

前回の重量・回数・セット・きつさを見ながら、今日のトレーニングを1行ずつ残すための薄い Web アプリです。記録の置き場は Notion を想定しています。このリポジトリはローカルで画面を動かす土台で、デプロイはしていません。

本番は AWS に置きます。Cloudflare はドメインの DNS だけです。方針は [docs/architecture-aws.md](docs/architecture-aws.md) にまとめてあります。

## 画面

1. **今日のトレーニング** … 日付、任意の部位メモ、今日の種目。各種目に、その種目を最後にやった日の行をすべて（`重量 × 回数 × セット` ときつさ）と、今日すでに保存した行を並べます。
2. **種目を追加** … 検索、最近使った種目、一覧、新しい種目名。
3. **記録** … 読み取り専用の「前回」と、前回の値を入れた「今日」。保存すると1行追加します。スキップは保存しません。

種目をタップすると記録画面へ進みます。同じ日に同じ種目を重量を変えて何度でも追加できます。先に保存した行は残り、前回の表示は今日の行で置き換わりません。

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
| `npm run test:api` | Go API（`api/`）の単体テスト。Go 1.22 が要る |
| `npm run typecheck` | 画面・設定・Worker の型チェック |
| `npm run build` | 静的ファイルを `dist/` へ出力（PWA のマニフェストと Service Worker を含む） |
| `npm run preview` | ビルド結果を <http://localhost:4173> で確認 |
| `npm run check:secrets` | ブラウザ側のソースと `dist/` に Notion のトークン類が無いことを確認 |

Cognito と `VITE_API_BASE_URL` が両方あるときは、ログイン後の記録は API Gateway 経由です。今日のメニュー・部位メモ・終了も `GET` / `PUT /api/day-plan` で DynamoDB に保存し、リロード後に復元します。保存先が無い初回は空のメニューです（シードの「脚」と 3 種目はモック用です）。どちらかが無いときはモックで、再読み込みすると記録もメニューも初期データに戻ります。

初期データは起動日を基準にしています。スクワットは昨日 60kg と 80kg、レッグプレスは昨日 1 行、レッグカールは 6 日前の前回と今日 2 行、です。

## データの境界

画面は `WorkoutLogClient` だけを見ます。本番の Notion アクセスは **API Gateway → Go Lambda（`api/`）** だけで、ブラウザは Notion を直接呼びません。トークンは SSM SecureString です。詳細は [docs/architecture-aws.md](docs/architecture-aws.md)。

`worker/` と `wrangler.toml` は API の形と Notion マッピングの参考実装です。**本番経路にはしません。** Go Lambda は `worker/` を import しません。本番の変更は `api/` に入れます。

```text
ブラウザ（React）
  WorkoutLogClient
    ├─ HTTP（src/data/httpClient.ts）
    │    Cognito の IdToken + VITE_API_BASE_URL があるとき
    │    起動時 GET /api/bootstrap、保存時 POST /api/logs、遷移はキャッシュ
    └─ インメモリのモック（src/data/browserClient.ts）
         Cognito か API ベース URL が無いとき
  今日のメニュー / 部位メモ / 終了
    ├─ Cognito または API の URL が無い … ブラウザのメモリ（シード）
    └─ ログイン済みかつ VITE_API_BASE_URL あり
         └─ GET/PUT /api/day-plan → Lambda → DynamoDB DayPlan

本番
  API Gateway（JWT Authorizer。Lambda はトークンを再検証しない）
    └─ Go Lambda api/（provided.al2023）
         ├─ SSM SecureString（トークンとデータベース ID。メモリに短時間キャッシュ）
         ├─ Notion API 2026-03-11
         └─ DynamoDB
              ├─ DayPlan（今日のメニュー。GET / PUT /api/day-plan）
              └─ 任意: NotionCache（300 秒。正データではない）

参考: Cloudflare Worker（デプロイしない）
  worker/notionClient.ts
```

Vite は `VITE_` で始まる変数だけをブラウザへ埋め込みます。`.env.example` の `VITE_` は Cognito / API の公開設定だけです（秘密ではない）。Notion のキーには `VITE_` を付けません。

### Lambda の API

`GET /api/health` だけ認証なしです。それ以外は API Gateway の JWT Authorizer が付いています。

| メソッド | 経路 | 内容 |
| --- | --- | --- |
| GET | `/api/health` | 死活。秘密は返さない |
| GET | `/api/exercises` | 種目一覧 |
| GET | `/api/exercises/recent` | 記録日が新しい順 |
| GET | `/api/logs/previous?exercise=&before=YYYY-MM-DD` | その種目で、その日より前に記録がある最新の日の行をすべて |
| GET | `/api/logs/today?exercise=&date=YYYY-MM-DD` | その日のその種目の行をすべて |
| GET | `/api/bootstrap?date=YYYY-MM-DD&exercise=` | 種目・最近・指定種目の前回と当日を一括。`exercise` は繰り返せる。`exercises=a,b` も可 |
| POST | `/api/logs` | 1 行追加。重量・回数・セット・きつさ・日付を検査してから Notion へ書く |
| GET | `/api/day-plan?date=YYYY-MM-DD` | そのユーザーのその日のメニュー。項目が無ければ空。ユーザーは JWT の `sub` |
| PUT | `/api/day-plan` | `{ date, memo, exercises, finished }` で DayPlan を置き換える。ログイン済みの画面が呼ぶ |

`date` は画面のセッション日付です。Lambda の UTC「今日」では上書きしません。

レート制限を避けるため、bootstrap と各 GET は同じ「最近の記録」ウィンドウを 300 秒キャッシュします。ウィンドウで前回が確定できない種目だけ、追加で 1 件問い合わせます。画面遷移のためには使いません。`POST /api/logs` のあと、種目一覧と最近ウィンドウとその種目のキャッシュを捨て、次の読みで Notion に戻ります。DynamoDB が使えないときはプロセス内メモリだけにします（`NOTION_CACHE=memory`）。キャッシュ項目は [docs/dynamodb.md](docs/dynamodb.md) の `NotionCache`（`pk=CACHE#notion`、セグメントを `#` で結んだ `sk`、TTL 300 秒）で、Go の `api/internal/ddb` が組み立てます。

画面（[#12](https://github.com/tag0203/kintore-memo/issues/12)）はセッション開始の `GET /api/bootstrap` と、保存の `POST /api/logs` だけを呼びます。種目一覧・前回・当日の個別 GET は使いません。保存に成功した行を、その種目の当日の並びに足します。前回の行は置き換えず、再取得もしません。

| 状態 | どこに置くか |
| --- | --- |
| 種目・重量・回数・セット数・きつさ・日付・タイトル | Notion の1行。同じ日・同じ種目でも保存のたびに追加（上書きしない）。列は増やさない |
| 前回 | その種目で、今日より前に記録がある最新の日の行をすべて。他の種目の日付では決めない。今日の行は含めない |
| 当日 | その日のその種目の行をすべて。先の行は後からの保存で消さない |
| 今日のメニュー、部位メモ、終了 / 再開 | DynamoDB の DayPlan 1 項目。Go API の `GET` / `PUT /api/day-plan`（[docs/dynamodb.md](docs/dynamodb.md)、[#6](https://github.com/tag0203/kintore-memo/issues/6)）。Cognito と API URL が無いローカルだけブラウザのメモリ |

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

データベースをインテグレーションに共有します。本番の `api/` と参考実装の `worker/` は、どちらも API `2026-03-11` でデータベースを開き、先頭のデータソースを使います。プロパティ名は次の通りです。括弧は全角です。

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

DynamoDB の単一テーブル（DayPlan と任意の Notion キャッシュ）は [docs/dynamodb.md](docs/dynamodb.md) です。本番の Lambda は Go の `api/` です（[#23](https://github.com/tag0203/kintore-memo/issues/23)）。画面の記録クライアントは `src/data/httpClient.ts` です（[#12](https://github.com/tag0203/kintore-memo/issues/12)）。今日のメニューは Go の `GET` / `PUT /api/day-plan` と `src/data/dayPlanClient.ts` です（[#6](https://github.com/tag0203/kintore-memo/issues/6)）。

GitHub Actions の CI は pull request と `main` で、テスト、型チェック、ビルド、`check:secrets`、Go のテスト、`sam validate --lint`、`sam build` を実行します。AWS への反映は OIDC の手動ワークフローで、ロールが未設定の間は何もしません。長期のアクセスキーは使いません。手順は [docs/github-actions-oidc.md](docs/github-actions-oidc.md) です。
