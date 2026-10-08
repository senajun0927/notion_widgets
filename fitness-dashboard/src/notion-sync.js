// Notion is the only input surface. No public write/sync endpoint.
export const SOURCES = Object.freeze({
  meal: 'e27f3a5c-0e05-4e28-9872-6ffb2c0eddce',
  training: '2676b1df-0290-47a6-8261-79a018f92359',
  daily: '198f9b9d-cf68-4df0-900d-1a68b63d15f2',
});
class SyncError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function value(properties, key, type) {
  const p = properties[key];
  if (!p || p.type !== type) throw new SyncError('schema_mismatch');
  return p[type];
}
function number(p, key) {
  const n = value(p, key, 'number');
  if (n !== null && (!Number.isFinite(n) || n < 0)) throw new SyncError('invalid_number');
  return n;
}
function text(p, key, type = 'rich_text') {
  return value(p, key, type).map(v => v.plain_text ?? v.text?.content ?? '').join('');
}
function date(raw) {
  if (typeof raw !== 'string') throw new SyncError('missing_date');
  const d = raw.includes('T') ? new Date(Date.parse(raw) + 9 * 3600000).toISOString().slice(0, 10) : raw;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || new Date(d+'T00:00:00Z').toISOString().slice(0,10) !== d) throw new SyncError('invalid_date');
  return d;
}
export function normalize(kind, page) {
  if (!/^[a-f0-9-]{32,36}$/i.test(page.id)) throw new SyncError('invalid_page_id');
  const p = page.properties;
  const day = kind === 'daily' ? value(p, 'Day', 'date')?.start ?? text(p, 'Date', 'title') : value(p, 'Date', 'date')?.start;
  const row = { kind, page_id: page.id.replaceAll('-', '').toLowerCase(), date: date(day) };
  const nutrition = () => ({ calories: number(p,'Calories'), protein: number(p,'Protein'), fat: number(p,'Fat'), carbs: number(p,'Carbs'), salt_g: number(p,'Salt g') });
  if (kind === 'meal') {
    const group = value(p,'Meal Group','select')?.name;
    if (!['朝食','昼食','夕食','間食・飲み物'].includes(group)) throw new SyncError('invalid_meal_group');
    row.payload = { ...nutrition(), meal_group: group, name: text(p,'Name','title') };
  } else if (kind === 'daily') {
    const score = number(p,'PFC Score');
    if (score !== null && score > 100) throw new SyncError('invalid_score');
    const notes = text(p,'Notes');
    row.payload = { ...nutrition(), pfc_score: score, weight_kg: number(p,'Weight kg'), workout_volume: number(p,'Workout Volume kg'), training: value(p,'Training','checkbox') ? 1 : 0, notes: /部分|未確定/.test(notes) ? 'partial '+notes : notes };
  } else if (kind === 'training') {
    const exercise = text(p,'Exercise').trim();
    if (!exercise || exercise.length > 200) throw new SyncError('invalid_exercise');
    const notes = text(p,'Notes');
    const count = number(p,'Sets');
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new SyncError('invalid_sets');
    const sets = [];
    for (let i = 1; i <= Math.min(count,3); i++) {
      const weight_kg = number(p,`Set ${i} kg`), reps = number(p,`Set ${i} reps`);
      if (weight_kg === null || !Number.isInteger(reps) || reps <= 0) throw new SyncError('incomplete_sets');
      sets.push({weight_kg,reps});
    }
    // Only explicitly numbered extra sets; never invent sets from a total volume.
    for (let i = 4; i <= count; i++) {
      const match = notes.match(new RegExp(`${i}セット目\\s*[:：]\\s*(\\d+(?:\\.\\d+)?)\\s*kg\\s*[×xｘ]\\s*(\\d+)`, 'i'));
      if (!match || Number(match[2]) < 1) throw new SyncError('incomplete_sets');
      sets.push({weight_kg:Number(match[1]),reps:Number(match[2])});
    }
    const actual = sets.reduce((s,v)=>s+v.weight_kg*v.reps,0);
    const stored = number(p,'Total Volume kg');
    row.payload = {exercise,notes,sets,volume:stored ?? actual,calculated_volume:actual,volume_mismatch:stored !== null && Math.abs(stored-actual) > 0.02};
  } else throw new SyncError('invalid_kind');
  return row;
}
async function querySource(id, token, fetcher, deadline) {
  const rows = [], seen = new Set(); let cursor;
  do {
    if (Date.now() > deadline || rows.length >= 2000) throw new SyncError('sync_limit');
    let response;
    for (let attempt=0; attempt<3; attempt++) {
      response = await fetcher(`https://api.notion.com/v1/data_sources/${id}/query`, {
        method:'POST', headers:{Authorization:`Bearer ${token}`,'Notion-Version':'2025-09-03','Content-Type':'application/json'},
        body:JSON.stringify({page_size:100,...(cursor ? {start_cursor:cursor} : {})}), signal:AbortSignal.timeout(20000), redirect:'manual',
      });
      if (response.ok) break;
      if ((response.status !== 429 && response.status < 500) || attempt === 2) throw new SyncError(`notion_http_${response.status}`);
      const delay = Math.min(10000, Math.max(1000, Number(response.headers.get('retry-after') || 1)*1000));
      await response.body?.cancel();
      await new Promise(resolve => setTimeout(resolve,delay));
    }
    const data = await response.json();
    if (!Array.isArray(data.results) || typeof data.has_more !== 'boolean') throw new SyncError('invalid_response');
    for(const page of data.results) if (!page.archived && !page.in_trash) rows.push(page);
    cursor = data.has_more ? data.next_cursor : null;
    if (data.has_more && (!cursor || seen.has(cursor))) throw new SyncError('invalid_cursor');
    if (cursor) seen.add(cursor);
  } while(cursor);
  return rows;
}
export async function applySnapshot(DB, rows, owner = null) {
  const dailyDates = new Set(), keys = new Set();
  for (const r of rows) {
    const key = r.kind+':'+r.page_id;
    if(keys.has(key) || (r.kind==='daily' && dailyDates.has(r.date))) throw new SyncError('duplicate_source_record');
    keys.add(key); if(r.kind==='daily') dailyDates.add(r.date);
  }
  // D1 batch is a transaction. Failed reads/validation never reach this point.
  // Ownership is checked inside the same transaction, preventing an expired run publishing.
  const guard = owner ? ' AND EXISTS(SELECT 1 FROM notion_sync_state WHERE lock_owner=? AND lock_until>?)' : '';
  const args = owner ? [owner,Date.now()] : [];
  const statements = [DB.prepare('DELETE FROM notion_records WHERE 1=1'+guard).bind(...args)];
  statements.push(DB.prepare("INSERT INTO notion_records(kind,page_id,date,payload) SELECT json_extract(value,'$.kind'),json_extract(value,'$.page_id'),json_extract(value,'$.date'),json_extract(value,'$.payload') FROM json_each(?) WHERE 1=1"+guard).bind(JSON.stringify(rows),...args));
  statements.push(DB.prepare('INSERT OR IGNORE INTO notion_owned_dates(kind,date) SELECT kind,date FROM notion_records WHERE 1=1'+guard).bind(...args));
  statements.push(DB.prepare("UPDATE notion_sync_state SET status='ok',last_success=?,record_count=?,error_code=NULL WHERE id=1"+(owner ? ' AND lock_owner=? AND lock_until>?' : '')).bind(new Date().toISOString(),rows.length,...args));
  await DB.batch(statements);
}
export async function syncNotion(env, fetcher = fetch) {
  const DB = env.DB;
  if (!env.NOTION_TOKEN) {
    await DB.prepare("UPDATE notion_sync_state SET status='not_configured',error_code='missing_notion_token' WHERE id=1").run();
    return {status:'not_configured'};
  }
  const owner = crypto.randomUUID(), now = Date.now();
  const lease = await DB.prepare("UPDATE notion_sync_state SET lock_owner=?,lock_until=?,last_attempt=?,status='running',error_code=NULL WHERE id=1 AND lock_until<=?").bind(owner,now+600000,new Date(now).toISOString(),now).run();
  if (!lease.meta.changes) return {status:'busy'};
  try {
    const rows=[];
    for(const [kind,id] of Object.entries(SOURCES)) {
      const pages = await querySource(id,env.NOTION_TOKEN,fetcher,now+240000);
      rows.push(...pages.map(p=>normalize(kind,p)));
    }
    if(Date.now()>now+240000) throw new SyncError('sync_limit');
    await applySnapshot(DB,rows,owner);
    return {status:'ok',records:rows.length};
  } catch(error) {
    // Never log Notion response bodies, credentials or private page content.
    const code = error instanceof SyncError ? error.code : 'sync_failed';
    await DB.prepare("UPDATE notion_sync_state SET status='error',error_code=? WHERE id=1 AND lock_owner=?").bind(code,owner).run();
    console.error(JSON.stringify({event:'notion_sync_failed',code,error_type:error.name,frames:String(error.stack || '').split('\n').filter(line => /^\s+at .+index\.js:\d+:\d+/.test(line)).slice(0,6)}));
    throw new SyncError(code);
  } finally {
    await DB.prepare('UPDATE notion_sync_state SET lock_owner=NULL,lock_until=0 WHERE id=1 AND lock_owner=?').bind(owner).run();
  }
}
