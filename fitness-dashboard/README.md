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
- 総ボリュームは既存の `daily.workout_volume` を優先する。NULLまたは日別行のない日だけ `workout_sets` を集計し、二重加算を防ぐ。
- 種目別は1行1セット。日ごとの最大重量、全セットの合計回数、`SUM(weight_kg * reps)` を表示。重量は記録時の総負荷kg。
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

データ入力は既存の運用を継続する。新しいインポーターで種目の記録を取り込む場合は `workout_sets(date, exercise, weight_kg, reps, notes)` に1セットずつ保存する。体重は既存の `daily.weight_kg` に保存する。日別総ボリュームを保存する運用では、同日の `daily.workout_volume` も整合させる。

## 検証

Node.js 24以上（テストのSQLite用）。

```sh
npm test
npm run check:build
```

テストでは実際のSQLiteクエリを実行し、期間境界、日本時間、集計、NULL/0、不正パラメータ、migrationの再適用・既存行保持を確認する。`check:build` はビルド済みWorkerが返すHTMLのスクリプトを実行し、ブラウザー用スクリプトにWorker用の補助関数が混入していないことを確認する。テスト用の体重・セット記録を本番へ挿入しない。
