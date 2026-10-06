import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, { period } from '../src/index.js';

const migration = readFileSync(new URL('../migrations/0001_workout_sets.sql', import.meta.url), 'utf8');
const schema = 'CREATE TABLE daily (date TEXT PRIMARY KEY, calories REAL, protein REAL, fat REAL, carbs REAL, salt_g REAL, pfc_score REAL, weight_kg REAL, workout_volume REAL, training INTEGER DEFAULT 0, notes TEXT); CREATE TABLE meals (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, meal_group TEXT NOT NULL, name TEXT, calories REAL, protein REAL, fat REAL, carbs REAL, salt_g REAL);';

function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schema);
  const DB = {
    prepare(sql) {
      let params = [];
      const statement = {
        bind(...args) { params = args; return statement; },
        async all() { return { results: sqlite.prepare(sql).all(...params).map(row => ({ ...row })), success: true }; },
      };
      return statement;
    },
    batch(statements) { return Promise.all(statements.map(s => s.all())); },
  };
  const call = (path, method = 'GET') => worker.fetch(new Request('https://fitness.test' + path, { method }), { DB });
  const today = period(new URLSearchParams()).end;
  const day = offset => new Date(Date.parse(today + 'T00:00:00Z') - offset * 86400000).toISOString().slice(0, 10);
  return { sqlite, DB, call, day, today };
}

test('period uses Japan date, inclusive 7/30 days and handles leap years', () => {
  assert.deepEqual(period(new URLSearchParams('range=7'), new Date('2026-10-05T15:00:00Z')), { range: '7', start: '2026-09-30', end: '2026-10-06', timezone: 'Asia/Tokyo' });
  assert.equal(period(new URLSearchParams('range=30'), new Date('2026-10-05T15:00:00Z')).start, '2026-09-07');
  assert.equal(period(new URLSearchParams('range=7'), new Date('2024-03-01T00:00:00Z')).start, '2024-02-24');
  assert.equal(period(new URLSearchParams()).start, null);
  assert.throws(() => period(new URLSearchParams('range=0')), RangeError);
});

test('migration is additive, idempotent, and rejects invalid set values', () => {
  const { sqlite, today } = setup();
  sqlite.prepare('INSERT INTO daily (date, calories, pfc_score) VALUES (?, 710, 32)').run(today);
  sqlite.prepare('INSERT INTO meals (date, meal_group, calories) VALUES (?, ?, 710)').run(today, '朝食');
  const before = ['daily', 'meals'].map(t => sqlite.prepare('SELECT * FROM ' + t).all());
  sqlite.exec(migration); sqlite.exec(migration);
  assert.deepEqual(['daily', 'meals'].map(t => sqlite.prepare('SELECT * FROM ' + t).all()), before);
  const insert = sqlite.prepare('INSERT INTO workout_sets (date, exercise, weight_kg, reps) VALUES (?, ?, ?, ?)');
  assert.throws(() => insert.run(today, 'Bench', -1, 8));
  assert.throws(() => insert.run(today, 'Bench', 50, 0));
  assert.throws(() => insert.run(today, 'Bench', 50, 2.5));
  assert.throws(() => insert.run(today, ' ', 50, 8));
  sqlite.close();
});

test('legacy daily API keeps arrays, nulls and zeros; periods include exact boundaries', async () => {
  const { sqlite, call, day, today } = setup(); sqlite.exec(migration);
  const insert = sqlite.prepare('INSERT INTO daily (date, calories, salt_g, workout_volume) VALUES (?, ?, ?, ?)');
  [0, 6, 7, 29, 30].forEach(offset => insert.run(day(offset), offset ? 2400 : 0, null, 0));
  const future = new Date(Date.parse(today + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  insert.run(future, 999, null, null);
  assert.equal((await (await call('/api/daily?range=7')).json()).length, 2);
  assert.equal((await (await call('/api/daily?range=30')).json()).length, 4);
  const all = await (await call('/api/daily')).json();
  assert.equal(all.length, 6);
  const current = all.find(r => r.date === today);
  assert.equal(current.calories, 0); assert.equal(current.salt_g, null); assert.equal(current.workout_volume, 0);
  sqlite.close();
});

test('meals retain daily group aggregation and do not convert unknown values to zero', async () => {
  const { sqlite, call, today } = setup(); sqlite.exec(migration);
  const insert = sqlite.prepare('INSERT INTO meals (date, meal_group, calories) VALUES (?, ?, ?)');
  insert.run(today, '朝食', 300); insert.run(today, '朝食', 250); insert.run(today, '夕食', null);
  const rows = await (await call('/api/meals?range=7')).json();
  assert.equal(rows.find(r => r.meal_group === '朝食').calories, 550);
  assert.equal(rows.find(r => r.meal_group === '夕食').calories, null);
  sqlite.close();
});

test('exercise aggregates maximum load, total reps, total volume, with safely bound names', async () => {
  const { sqlite, call, today, day } = setup(); sqlite.exec(migration);
  const insert = sqlite.prepare('INSERT INTO workout_sets (date, exercise, weight_kg, reps) VALUES (?, ?, ?, ?)');
  insert.run(today, 'Bench', 50, 10); insert.run(today, 'Bench', 55, 8);
  insert.run(today, 'Squat', 70, 10); insert.run(day(7), 'Bench', 45, 10);
  const name = "Row' OR 1=1 --"; insert.run(today, name, 0, 12);
  const data = await (await call('/api/exercise?range=7&name=Bench')).json();
  assert.deepEqual(data.days, [{ date: today, weight_kg: 55, reps: 18, volume: 940, sets: 2 }]);
  const bound = await (await call('/api/exercise?name=' + encodeURIComponent(name))).json();
  assert.equal(bound.days.length, 1); assert.equal(bound.days[0].volume, 0);
  assert.equal((await (await call('/api/exercises')).json()).length, 3);
  sqlite.close();
});

test('dashboard returns fixed targets, existing scores and separate set totals, without writes', async () => {
  const { sqlite, call, today } = setup(); sqlite.exec(migration);
  sqlite.prepare('INSERT INTO daily (date, pfc_score, workout_volume) VALUES (?, 84, 5635)').run(today);
  sqlite.prepare('INSERT INTO workout_sets (date, exercise, weight_kg, reps) VALUES (?, ?, 50, 10)').run(today, 'Bench');
  const before = sqlite.prepare('SELECT * FROM daily').all();
  const result = await (await call('/api/dashboard?range=7')).json();
  assert.deepEqual(result.targets, { calories: [2300, 2500], protein: [120, 140], fat: [55, 70], carbs: [290, 340] });
  assert.equal(result.daily[0].pfc_score, 84); assert.equal(result.daily[0].workout_volume, 5635);
  assert.equal(result.workout_days[0].volume, 500);
  assert.deepEqual(sqlite.prepare('SELECT * FROM daily').all(), before);
  sqlite.close();
});

test('invalid parameters, routes, methods and DB errors return appropriate responses', async () => {
  const { sqlite, call } = setup(); sqlite.exec(migration);
  assert.equal((await call('/api/daily?range=no')).status, 400);
  assert.equal((await call('/api/exercise')).status, 400);
  assert.equal((await call('/api/exercise?name=' + 'a'.repeat(201))).status, 400);
  assert.equal((await call('/api/unknown')).status, 404);
  assert.equal((await call('/api/dashboard', 'POST')).status, 405);
  const head = await call('/api/dashboard', 'HEAD'); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  sqlite.exec('DROP TABLE workout_sets');
  const response = await call('/api/dashboard'); assert.equal(response.status, 500);
  assert.match((await response.json()).error, /取得できません/);
  sqlite.close();
});

test('HTML has no external script dependency and can be embedded in Notion', async () => {
  const { sqlite, call } = setup();
  const response = await call('/'); const html = await response.text();
  assert.match(html, /name="viewport"/); assert.match(html, /data-range="30"/);
  assert.doesNotMatch(html, /<script[^>]+src=/); assert.doesNotMatch(response.headers.get('content-security-policy'), /frame-ancestors/);
  sqlite.close();
});
