import { page } from './page.js';

export const TARGETS = Object.freeze({
  calories: [2300, 2500], protein: [120, 140], fat: [55, 70], carbs: [290, 340],
});

// Dates in D1 are YYYY-MM-DD in Japan time. Never use the visitor's timezone.
export function period(searchParams, now = new Date()) {
  const range = searchParams.get('range') || 'all';
  if (!['7', '30', 'all'].includes(range)) {
    throw new RangeError('range は 7 / 30 / all を指定してください。');
  }
  const end = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
  const start = range === 'all' ? null : new Date(Date.parse(end + 'T00:00:00Z') - (Number(range) - 1) * 86400000).toISOString().slice(0, 10);
  return { range, start, end, timezone: 'Asia/Tokyo' };
}

function filtered(db, sql, p) {
  const where = p.start ? ' WHERE date >= ? AND date <= ?' : '';
  const stmt = db.prepare(sql.replace('/*period*/', where));
  return p.start ? stmt.bind(p.start, p.end) : stmt;
}

const DAILY = 'SELECT * FROM daily /*period*/ ORDER BY date';
const MEALS = 'SELECT date, meal_group, SUM(calories) calories FROM meals /*period*/ GROUP BY date, meal_group ORDER BY date, meal_group';
const VOLUMES = 'SELECT date, SUM(weight_kg * reps) volume FROM workout_sets /*period*/ GROUP BY date ORDER BY date';
const EXERCISES = 'SELECT exercise, COUNT(*) sets, MAX(date) last_date FROM workout_sets GROUP BY exercise ORDER BY exercise';

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(request.method === 'HEAD' ? null : page, { headers: {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
      } });
    }
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
    if (!['/api/daily', '/api/meals', '/api/dashboard', '/api/exercises', '/api/exercise'].includes(url.pathname)) {
      return json({ error: 'Not found' }, 404);
    }
    try {
      const p = period(url.searchParams);
      let data;
      switch (url.pathname) {
        case '/api/daily':
          data = (await filtered(env.DB, DAILY, p).all()).results;
          break;
        case '/api/meals':
          data = (await filtered(env.DB, MEALS, p).all()).results;
          break;
        case '/api/exercises':
          data = (await env.DB.prepare(EXERCISES).all()).results;
          break;
        case '/api/exercise': {
          const name = url.searchParams.get('name');
          if (!name || name.length > 200) return json({ error: 'name に種目名を指定してください（200文字以内）。' }, 400);
          const dateFilter = p.start ? ' AND date >= ? AND date <= ?' : '';
          // One row is one set: daily max weight, total repetitions and volume.
          const sql = 'SELECT date, MAX(weight_kg) weight_kg, SUM(reps) reps, SUM(weight_kg * reps) volume, COUNT(*) sets FROM workout_sets WHERE exercise = ?' + dateFilter + ' GROUP BY date ORDER BY date';
          const rows = await env.DB.prepare(sql).bind(name, ...(p.start ? [p.start, p.end] : [])).all();
          data = { period: p, exercise: name, days: rows.results };
          break;
        }
        case '/api/dashboard': {
          const [daily, meals, volumes, exercises] = await env.DB.batch([
            filtered(env.DB, DAILY, p), filtered(env.DB, MEALS, p),
            filtered(env.DB, VOLUMES, p), env.DB.prepare(EXERCISES),
          ]);
          data = { period: p, targets: TARGETS, daily: daily.results, meals: meals.results,
            workout_days: volumes.results, exercises: exercises.results };
          break;
        }
      }
      const response = json(data);
      return request.method === 'HEAD' ? new Response(null, response) : response;
    } catch (error) {
      if (error instanceof RangeError) return json({ error: error.message }, 400);
      console.error(JSON.stringify({ event: 'dashboard_query_failed', path: url.pathname, error: error.name }));
      return json({ error: 'データを取得できませんでした。時間をおいて再度お試しください。' }, 500);
    }
  },
};
