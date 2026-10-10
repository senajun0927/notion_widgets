-- Preserve every legacy row. Only the separate Notion mirror is refreshed.
CREATE TABLE IF NOT EXISTS notion_records (
  kind TEXT NOT NULL CHECK(kind IN ('daily','meal','training')),
  page_id TEXT NOT NULL,
  date TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  PRIMARY KEY(kind,page_id)
);
CREATE INDEX IF NOT EXISTS notion_records_date ON notion_records(kind,date);
CREATE TABLE IF NOT EXISTS notion_sync_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  status TEXT NOT NULL DEFAULT 'not_configured',
  last_attempt TEXT, last_success TEXT, error_code TEXT,
  record_count INTEGER, lock_owner TEXT, lock_until INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO notion_sync_state(id) VALUES(1);
-- Once a date has a Notion counterpart, legacy copies remain as backup only.
CREATE TABLE IF NOT EXISTS notion_owned_dates (
  kind TEXT NOT NULL, date TEXT NOT NULL, PRIMARY KEY(kind,date)
);
CREATE VIEW IF NOT EXISTS dashboard_meals AS
SELECT date, json_extract(payload,'$.meal_group') meal_group,
 json_extract(payload,'$.name') name, json_extract(payload,'$.calories') calories,
 json_extract(payload,'$.protein') protein, json_extract(payload,'$.fat') fat,
 json_extract(payload,'$.carbs') carbs, json_extract(payload,'$.salt_g') salt_g
FROM notion_records WHERE kind='meal'
UNION ALL SELECT date,meal_group,name,calories,protein,fat,carbs,salt_g FROM meals
WHERE NOT EXISTS(SELECT 1 FROM notion_owned_dates n WHERE n.kind='meal' AND n.date=meals.date);
CREATE VIEW IF NOT EXISTS dashboard_workout_sets AS
SELECT n.date, json_extract(n.payload,'$.exercise') exercise,
 json_extract(j.value,'$.weight_kg') weight_kg, json_extract(j.value,'$.reps') reps,
 json_extract(n.payload,'$.notes') notes
FROM notion_records n,json_each(n.payload,'$.sets') j WHERE n.kind='training'
UNION ALL SELECT date,exercise,weight_kg,reps,notes FROM workout_sets
WHERE NOT EXISTS(SELECT 1 FROM notion_owned_dates n WHERE n.kind='training' AND n.date=workout_sets.date);
CREATE VIEW IF NOT EXISTS dashboard_daily AS
WITH dates AS (SELECT date FROM notion_records UNION SELECT date FROM daily
 WHERE NOT EXISTS(SELECT 1 FROM notion_owned_dates n WHERE n.kind='daily' AND n.date=daily.date)),
food AS (SELECT date,SUM(json_extract(payload,'$.calories')) calories,
 SUM(json_extract(payload,'$.protein')) protein,SUM(json_extract(payload,'$.fat')) fat,
 SUM(json_extract(payload,'$.carbs')) carbs,
 CASE WHEN COUNT(json_extract(payload,'$.salt_g'))=COUNT(*) THEN SUM(json_extract(payload,'$.salt_g')) END salt_g
 FROM notion_records WHERE kind='meal' GROUP BY date),
training AS (SELECT date,SUM(json_extract(payload,'$.volume')) volume FROM notion_records WHERE kind='training' GROUP BY date),
summary AS (SELECT date,payload FROM notion_records WHERE kind='daily')
SELECT d.date,
 CASE WHEN f.date IS NOT NULL THEN f.calories WHEN EXISTS(SELECT 1 FROM notion_owned_dates n WHERE n.kind='meal' AND n.date=d.date) THEN NULL WHEN s.date IS NOT NULL THEN json_extract(s.payload,'$.calories') ELSE l.calories END calories,
 CASE WHEN f.date IS NOT NULL THEN f.protein WHEN EXISTS(SELECT 1 FROM notion_owned_dates n WHERE n.kind='meal' AND n.date=d.date) THEN NULL WHEN s.date IS NOT NULL THEN json_extract(s.payload,'$.protein') ELSE l.protein END protein,
 CASE WHEN f.date IS NOT NULL THEN f.fat WHEN EXISTS(SELECT 1 FROM notion_owned_dates n WHERE n.kind='meal' AND n.date=d.date) THEN NULL WHEN s.date IS NOT NULL THEN json_extract(s.payload,'$.fat') ELSE l.fat END fat,
 CASE WHEN f.date IS NOT NULL THEN f.carbs WHEN EXISTS(SELECT 1 FROM notion_owned_dates n WHERE n.kind='meal' AND n.date=d.date) THEN NULL WHEN s.date IS NOT NULL THEN json_extract(s.payload,'$.carbs') ELSE l.carbs END carbs,
 CASE WHEN f.date IS NOT NULL THEN f.salt_g WHEN EXISTS(SELECT 1 FROM notion_owned_dates n WHERE n.kind='meal' AND n.date=d.date) THEN NULL WHEN s.date IS NOT NULL THEN json_extract(s.payload,'$.salt_g') ELSE l.salt_g END salt_g,
 CASE WHEN s.date IS NOT NULL THEN json_extract(s.payload,'$.pfc_score') ELSE l.pfc_score END pfc_score,
 CASE WHEN s.date IS NOT NULL THEN json_extract(s.payload,'$.weight_kg') ELSE l.weight_kg END weight_kg,
 CASE WHEN t.date IS NOT NULL THEN t.volume WHEN EXISTS(SELECT 1 FROM notion_owned_dates n WHERE n.kind='training' AND n.date=d.date) THEN 0 WHEN s.date IS NOT NULL THEN json_extract(s.payload,'$.workout_volume') ELSE l.workout_volume END workout_volume,
 CASE WHEN t.date IS NOT NULL THEN 1 WHEN s.date IS NOT NULL THEN json_extract(s.payload,'$.training') ELSE l.training END training,
 CASE WHEN s.date IS NOT NULL THEN json_extract(s.payload,'$.notes') ELSE l.notes END notes
FROM dates d LEFT JOIN food f ON f.date=d.date LEFT JOIN summary s ON s.date=d.date
LEFT JOIN training t ON t.date=d.date LEFT JOIN daily l ON l.date=d.date AND NOT EXISTS(SELECT 1 FROM notion_owned_dates n WHERE n.kind='daily' AND n.date=d.date);
