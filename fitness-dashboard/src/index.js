import { page } from './page.js';
import { syncNotion } from './notion-sync.js';

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

const DAILY = 'SELECT * FROM dashboard_daily /*period*/ ORDER BY date';
const MEALS = 'SELECT date, meal_group, SUM(calories) calories FROM dashboard_meals /*period*/ GROUP BY date, meal_group ORDER BY date, meal_group';
const VOLUMES = `SELECT w.date, COALESCE((SELECT SUM(json_extract(n.payload,'$.volume')) FROM notion_records n WHERE n.kind='training' AND n.date=w.date),SUM(w.weight_kg*w.reps)) volume FROM dashboard_workout_sets w /*period*/ GROUP BY w.date ORDER BY w.date`;
const EXERCISES = 'SELECT exercise, COUNT(*) sets, MAX(date) last_date FROM dashboard_workout_sets GROUP BY exercise ORDER BY exercise';

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncNotion(env));
  },
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
    if (!['/api/daily', '/api/meals', '/api/dashboard', '/api/exercises', '/api/exercise', '/api/sync/status'].includes(url.pathname)) {
      return json({ error: 'Not found' }, 404);
    }
    try {
      if (url.pathname === '/api/sync/status') {
        const state = await env.DB.prepare('SELECT status,last_attempt,last_success,error_code,record_count FROM notion_sync_state WHERE id=1').first();
        return json({ ...state, configured: Boolean(env.NOTION_TOKEN), interval_minutes: 5 });
      }
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
          const sql = `SELECT w.date, MAX(w.weight_kg) weight_kg, SUM(w.reps) reps, COALESCE((SELECT SUM(json_extract(n.payload,'$.volume')) FROM notion_records n WHERE n.kind='training' AND n.date=w.date AND json_extract(n.payload,'$.exercise')=w.exercise), SUM(w.weight_kg*w.reps)) volume, COUNT(*) sets FROM dashboard_workout_sets w WHERE exercise = ?` + dateFilter + ' GROUP BY w.date ORDER BY w.date';
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
