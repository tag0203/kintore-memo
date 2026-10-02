# DynamoDB 単一テーブル

Issue [#11](https://github.com/tag0203/kintore-memo/issues/11)。アプリ固有データだけを、オンデマンドのテーブル 1 つに置く。記録の正は Notion のままです。方針は [architecture-aws.md](./architecture-aws.md) が正で、このページはキーと TTL だけを固定します。

テーブル定義と Lambda の IAM は `infra/template.yaml` の `AppTable` です。本番の項目は Go の `api/internal/ddb` が作ります。非推奨の Node 参照は `backend/dynamodb.mjs` です。AWS への実デプロイはしません。

## 物理テーブル

| 項目 | 値 |
| --- | --- |
| 名前 | `${ProjectName}-${Environment}`（既定 `kintore-memo-dev`） |
| 課金 | オンデマンド（`PAY_PER_REQUEST`） |
| パーティションキー | `pk`（String） |
| ソートキー | `sk`（String） |
| TTL 属性 | `ttl`（Number、Unix 秒）。有効 |
| GSI / LSI / Stream | なし。読み取りは `pk` + `sk` が分かっているときだけ |
| PITR | オフ |

エンティティは次の 2 つだけです。

| entityType | 役割 | 誰が読むか |
| --- | --- | --- |
| `DayPlan` | その日のメニュー、部位メモ、終了状態 | [#6](https://github.com/tag0203/kintore-memo/issues/6) |
| `NotionCache` | Notion API 応答の短いキャッシュ（任意） | [#10](https://github.com/tag0203/kintore-memo/issues/10) |

置かないもの: お気に入り、最近開いたページ、長い編集履歴、ジョブ状態、重量・回数・セット・きつさの記録行。種目の「最近」は Notion の記録日から導出します。キャッシュキーが `exercises#recent` になることはあっても、最近開いたページのエンティティは作りません。

## キー

```text
DayPlan
  pk = USER#<cognito-sub>
  sk = DAY#<YYYY-MM-DD>

NotionCache
  pk = CACHE#notion
  sk = <segment>(#<segment>){0,3}
```

`cognito-sub` は API Gateway JWT の `sub` をそのまま使います。UUID です。リクエスト本文のユーザー ID ではキーを作りません。

`YYYY-MM-DD` は画面のセッション日付です（`src/domain.ts` の `toISODate`。端末のローカル暦日）。Lambda は UTC で動くので、この日付をサーバーの「今日」で上書きしません。

Notion のキャッシュはデプロイにつきデータベースが 1 つなので、ユーザーごとに分けません。同じセグメントの Put は上書きです。版を増やしません。

セグメントは 1〜4 個、各 80 文字までです。`#` と制御文字はセグメントに含めません。種目名も同じ禁止文字です。#10 が読む GET に対応する例（閉じた一覧ではない）:

| 用途 | segments |
| --- | --- |
| 種目一覧 | `exercises` |
| 最近使った種目の応答 | `exercises` / `recent` |
| 前回 | `logs` / `previous` / `<種目名>` / `<before>` |
| その日の記録 | `logs` / `today` / `<種目名>` / `<date>` |
| bootstrap | `bootstrap` |

## DayPlan の属性

画面のセッション（`src/session.tsx`）と 1 対 1 です。1 ユーザー・1 日付につき 1 項目です。メニューと部位メモと終了状態を、別項目には分けません。

| 属性 | 型 | 内容 |
| --- | --- | --- |
| `pk` / `sk` | String | 上記 |
| `entityType` | String | `DayPlan` |
| `userId` | String | `sub`。`pk` と一致する |
| `date` | String | `sk` の日付と一致する |
| `memo` | String | 部位メモ。改行は取り除く。空でよい。80 文字まで（画面の `maxLength`） |
| `exercises` | List of String | 今日のメニュー。順序を保つ。重複なし。40 件まで。名前は 80 文字まで。新規入力の画面上限は 40 文字 |
| `finished` | Boolean | 終了していれば true。再開で false |
| `updatedAt` | String | 書き込み時刻（ISO-8601、UTC） |
| `ttl` | Number | 下表 |

`api/internal/ddb` の `BuildDayPlanItem`（同じ規則の Node 参照は `backend/dynamodb.mjs`）は、この属性以外を受け取りません。

## NotionCache の属性

| 属性 | 型 | 内容 |
| --- | --- | --- |
| `pk` / `sk` | String | 上記。`sk` はセグメントを `#` で結んだもの |
| `entityType` | String | `NotionCache` |
| `cacheKey` | String | `sk` と同じ |
| `body` | String | 応答の JSON 文字列。中身は正データではない。350,000 文字まで |
| `cachedAt` | String | 書き込み時刻（ISO-8601、UTC） |
| `ttl` | Number | 書き込み時刻 + 300 秒 |

## TTL

属性名はどちらも `ttl` です。期限を過ぎると項目ごと消えます。更新 API はありません。

| 用途 | entityType | 保持 | 期限の計算 |
| --- | --- | --- | --- |
| 今日のメニュー、部位メモ、終了 / 再開 | `DayPlan` | セッション日と、その次の東京の暦日 | `date` の翌々日 0:00（Asia/Tokyo）。例: `2026-10-02` → `2026-10-04 00:00 +09:00`（`2026-10-03T15:00:00Z`） |
| Notion API 応答 | `NotionCache` | 300 秒 | `floor(now/1000) + 300` |

DayPlan の書き込みは、Asia/Tokyo の当日・前日・翌日の `date` だけ受けます。端末のタイムゾーンと深夜 0 時のずれ用です。遠い日付を書いて履歴にはしません。前日の項目は、東京の翌暦日が終わるまで TTL で残ります。履歴画面のための Query はしません。

キャッシュは画面遷移の代わりにしません。bootstrap や再取得の短時間だけ Lambda が使います。Notion へ保存したあとは、そのキーを `DeleteItem` するか、同じキーへ Put して上書きします。

## アクセスと IAM

| 操作 | API | 呼び元 |
| --- | --- | --- |
| その日の DayPlan を読む | `GetItem` | Go の `GET /api/day-plan`（画面の接続は #6） |
| DayPlan を書く | `PutItem`（全体） | Go の `PUT /api/day-plan`（画面の接続は #6） |
| キャッシュを読む | `GetItem` | Go API |
| キャッシュを書く | `PutItem` | Go API |
| キャッシュを捨てる | `DeleteItem` | Go API |

Lambda ロール `ApiFunctionRole` の `DynamoDBTableAccess` は、上の 4 アクションだけを `AppTable` の ARN に許可します。GSI が無いので `index/*` は付けません。`Scan` と `Query` と Batch は付けません。ユーザーごとの分離は IAM 条件ではなく、ハンドラが `sub` から `pk` を組むことで行います。

環境変数 `TABLE_NAME` がこのテーブル名です。

## Issue #6 が乗せる場所

#6 は画面の復元を実装します。Go API（[#23](https://github.com/tag0203/kintore-memo/issues/23)）は次のルートを既に持っています。画面はまだ呼びません。

| メソッド | 経路 | 動作 |
| --- | --- | --- |
| GET | `/api/day-plan?date=YYYY-MM-DD` | `GetItem`（`DayPlanKey(sub, date)`）と読み取り検証。項目が無ければ `memo: ""`、`exercises: []`、`finished: false`、`updatedAt: null`。シードの「脚」と 3 種目は返さない |
| PUT | `/api/day-plan` | 本文の `date` / `memo` / `exercises` / `finished` を `BuildDayPlanItem` に渡し、`PutItem` で項目ごと置き換える。`userId` は本文ではなく JWT の `sub` |

この設計では次を固定しています。

1. 認証済みリクエストの `requestContext.authorizer.jwt.claims.sub` を `userId` にする。
2. 画面が持っている `date` / `memo` / `exercises` / `finished` を `buildDayPlanItem` に渡す。
3. 復元は `GetItem`（`dayPlanKey(sub, date)`）と `readDayPlanItem`。項目が無ければ、いまの初期表示と同じく空のメニューでよい（シードの「脚」と 3 種目はモック用で、DynamoDB の初期値ではない）。
4. リロード後も同じ `date` なら同じ項目が返る。`ttl` を毎書き込みで入れ、TTL 切れを履歴の代わりにする。
5. 重量・回数・セット・きつさは Notion の行のまま。DayPlan にコピーしない。

[#6](https://github.com/tag0203/kintore-memo/issues/6) の完了条件「方針とスキーマが README / docs に書かれている」のうち、スキーマは本ページです。読み書き API は Go（[#23](https://github.com/tag0203/kintore-memo/issues/23)）にあります。画面の接続は #6 側です。
