# 筋トレメモ

前回の重量・回数・セット・きつさを見ながら、今日のトレーニングを1行ずつ残すための薄い Web アプリです。記録の置き場は Notion を想定しています。このリポジトリはローカルで画面を動かす土台で、デプロイはしていません。

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

```text
ブラウザ（React）
  WorkoutLogClient
    └─ インメモリのモック   ← いま動く経路。src/data/browserClient.ts

Cloudflare Worker（未接続）
  同じ WorkoutLogClient
    └─ Notion 実装         ← worker/notionClient.ts
         NOTION_TOKEN
         NOTION_DATABASE_ID
              └─ Notion API 2026-03-11
```

画面は `src/data/client.ts` の `WorkoutLogClient` だけを見ます。Notion の URL やトークンを読むコードは `worker/` にしかありません。Vite は `VITE_` で始まる変数だけをブラウザへ埋め込みます。`.env.example` のキーに `VITE_` は付けていません。

| 状態 | どこに置くか |
| --- | --- |
| 種目・重量・回数・セット数・きつさ・日付・タイトル | Notion の1行。保存のたびに追加（上書きしない） |
| 前回 | その種目で、今日より前の最新1行 |
| 今日のメニュー、部位メモ、終了 / 再開 | ブラウザのセッション。指定スキーマに列が無いため |

モックの「最近」は、ピッカーで選んだ順です（初期並びは画面案に合わせています）。Worker 側の「最近」は、記録日が新しい順です。

## シークレット

- 本物のトークンやデータベース ID を git、フロントのソース、`VITE_` 変数に置かない。
- ローカル用の控えが要る場合も `.env` に書き、コミットしない（`.gitignore` 済み）。
- Worker へ渡すときはファイルではなくシークレットにする。

```bash
npx wrangler secret put NOTION_TOKEN
npx wrangler secret put NOTION_DATABASE_ID
```

`.env.example` は空のプレースホルダだけです。

## Notion の形

データベースをインテグレーションに共有します。Worker は API `2026-03-11` でデータベースを開き、先頭のデータソースを使います。プロパティ名は次の通りです。括弧は全角です。

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

## Cloudflare への次の段階

このリポジトリは Pages にも Workers にも載せていません。`wrangler.toml` は雛形です。

1. 上のスキーマで Notion データベースを作る。
2. `NOTION_TOKEN` と `NOTION_DATABASE_ID` を Worker のシークレットにする。オリジンが分かれる場合だけ `ALLOWED_ORIGIN` を足す。
3. Worker はすでに次の API を持っています。画面はまだ呼びません。
   - `GET /api/health`
   - `GET /api/exercises`
   - `GET /api/exercises/recent`
   - `GET /api/logs/previous?exercise=&before=YYYY-MM-DD`
   - `GET /api/logs/today?exercise=&date=YYYY-MM-DD`
   - `POST /api/logs`
4. 静的ファイルは `npm run build` の `dist/` を Cloudflare Pages に置く。
5. 画面側は `createBrowserClient` を、この API を叩く `WorkoutLogClient` に差し替える。差し替え先もトークンを持たない。
6. `npm run check:secrets` をビルド後にも通し、`dist/` にトークンや Notion の URL が無いことを確認する。
