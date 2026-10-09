# Fitness Dashboard

Cloudflare Workers + D1 の個人用ダッシュボード。

本番: https://fitness-dashboard.senajun0927.workers.dev

## 表示と集計

- 7日 / 30日 / 全期間。7日・30日は日本時間の今日を含む直近の暦日。全期間は保存済みの全日付。
- カロリー目標帯: 2,300–2,500 kcal。
- PFC目標帯: P 120–140g / F 55–70g / C 290–340g。見やすさのため3つのグラフに分割。
- PFC Score: `daily.pfc_score` の保存済みスコアを表示。再計算や書き換えはしない。縦軸0–100点。
- 塩分、朝食・昼食・夕食・間食のカロリー、体重、筋トレ総ボリューム。
- 間食と飲み物はまとめて表示。未記録の食事は0扱いにしない。
- 総ボリュームは同期済み Training Log を優先する。未同期の日付は既存の `daily.workout_volume`、NULLの場合は `workout_sets` の集計値を使い、二重加算を防ぐ。
- 種目別は日ごとの最大重量、全セットの合計回数、Notionの保存済み総ボリュームを表示。未保存の場合は `SUM(weight_kg * reps)`。重量は記録時の総負荷kg。
- 未記録は「—」とグラフの空白。保存済みの0は0として表示。
- `daily.notes` に `partial` / `途中` / `未完` がある日は、入力途中であることを明示。
- タップ・マウス・左右キーで日別の値を確認でき、各グラフの下には日別表もある。
- 外部CDNやグラフライブラリへの依存なし。Notionへの埋め込みも維持。

体重・種目別記録が未登録の場合、空の状態を表示する。既存の総ボリュームから種目やセットを推測して生成しない。

## API

全エンドポイントは読み取り専用。`GET` / `HEAD` のみ。

| エンドポイント | 内容 |
| --- | --- |
| `/api/daily` | 既存形式の日別データ配列 |
| `/api/meals` | 既存形式の食事区分別カロリー配列 |
| `/api/dashboard?range=7` | 期間、目標値、日別、食事、セット由来の日別総量、種目一覧 |
| `/api/exercises` | 全期間の種目一覧（期間内に記録のない種目も選択可能） |
| `/api/exercise?range=30&name=ベンチプレス` | 指定種目の日別最大重量・合計回数・合計ボリューム・セット数 |

`range=7|30|all` を指定可能。APIで省略すると既存の挙動を保つため `all`。画面の初期値は7日。種目名はURLエンコードする。不正パラメータは400、未知のパスは404、DBエラーは500。

## Migration / デプロイ

既存の `daily` / `meals` を持つ同名D1を前提とする。`0001_workout_sets.sql` はセット用テーブルとインデックスを追加するだけで、既存行の更新・削除・テーブル再作成を行わない。

```sh
npm ci
# 認証済みの環境で、本番への変更前にバックアップ（Git管理外へ）
npx wrangler d1 export fitness-dashboard --remote --output /tmp/fitness-backup.sql
npx wrangler d1 migrations apply fitness-dashboard --remote
npm run deploy
```

Cloudflareのトークン等は環境変数、Wranglerログイン、Worker Secretsで管理する。`.env` / `.dev.vars` / バックアップ / `.wrangler` はコミットしない。

データ入力は Notion に一本化し、下記の自動同期を利用する。

## 検証

Node.js 24以上（テストのSQLite用）。

```sh
npm test
npm run check:build
```

テストでは実際のSQLiteクエリを実行し、期間境界、日本時間、集計、NULL/0、不正パラメータ、migrationの再適用・既存行保持を確認する。`check:build` はビルド済みWorkerが返すHTMLのスクリプトを実行し、ブラウザー用スクリプトにWorker用の補助関数が混入していないことを確認する。テスト用の体重・セット記録を本番へ挿入しない。

## Notion → D1 自動同期

入力は Notion のみ。Cron `*/5 * * * *` で既存の Food Log / Training Log / Daily Fitness Summary を読む。読み取り専用 integration を作成し Fitness ページ配下の3データベースへアクセスを付与し、Worker の Secret `NOTION_TOKEN` にトークンを登録する。ChatGPT の Notion 接続とは別の Worker 用接続が必要。

```sh
npx wrangler secret put NOTION_TOKEN
```

トークンはチャット・コード・Gitに保存しない。Secret設定後は次の定期実行で初回同期する（Cron反映は最大15分）。D1への手入力は不要。画面上部と `/api/sync/status` に同期状態・成功日時を表示する。更新ボタンは表示を再取得する。

`0002_notion_sync.sql` は元テーブルを変更せず、ミラー・同期状態・表示用viewを追加する。NotionページIDをキーに、各ソースの全ページ取得・検証後、成功したソースをD1トランザクションで置換。訂正・削除・アーカイブを反映し、失敗したソースは前回成功データを保持する。筋トレが失敗しても食事・体重・PFC Score の同期は継続し、画面とAPIに一部失敗を表示する。期限付きロックで重複実行を防ぐ。Notionに一度取り込まれた日付は所有履歴を保存し、削除後に古いD1コピーが復活しない。元の `daily` / `meals` / `workout_sets` は残し、Notionにない既存日付は表示を継続する。

- カロリー・PFCは Food Log を日別集計し、サマリー更新を待たず反映。塩分は全食事の値がそろう日のみ日計を表示し、一部不明ならNULL。
- 体重・PFC Scoreは Daily Fitness Summary の保存値。スコアは再計算しない。未作成サマリーの値は未記録。
- Training Log はSet列と `4セット目: 60kg×13` 形式、または `全セット: 20kg×10、40kg×10、50kg×8、50kg×6、40kg×8。` 形式のNotesを読む。全セット一覧はセット数とSet列の両方に一致することを検証し、文末以降のトップセット説明は加算しない。未記録セットは推測せず、そのソースの同期エラーにする。
- 重量は日別最大、回数は全セット合計。ボリュームは Notion の `Total Volume kg` を優先し、未記録時のみセットから計算。差はミラーの `volume_mismatch` に保持し、元Notionは変更しない。
- 各ソース2,000件、取得4分の保護上限。上限・権限不足・プロパティの名前/型変更・同日日次サマリー重複等は同期エラーになる。API 429/5xxは再試行する。

旧Workerを再デプロイすれば元テーブル表示へ戻せる。追加テーブルの削除は不要。
