-- Additive only: daily and meals records are never updated or rebuilt.
-- Each row represents one set. Weight is the recorded total load in kg.
CREATE TABLE IF NOT EXISTS workout_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  exercise TEXT NOT NULL CHECK (length(trim(exercise)) BETWEEN 1 AND 200),
  weight_kg REAL NOT NULL CHECK (weight_kg >= 0),
  reps INTEGER NOT NULL CHECK (reps > 0 AND reps = CAST(reps AS INTEGER)),
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_workout_sets_exercise_date ON workout_sets (exercise, date);
CREATE INDEX IF NOT EXISTS idx_workout_sets_date ON workout_sets (date);
CREATE INDEX IF NOT EXISTS idx_meals_date ON meals (date);
