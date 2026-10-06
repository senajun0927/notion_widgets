import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { normalize, applySnapshot, syncNotion, SOURCES } from '../src/notion-sync.js';
function setup() {
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec('CREATE TABLE daily(date TEXT PRIMARY KEY,calories REAL,protein REAL,fat REAL,carbs REAL,salt_g REAL,pfc_score REAL,weight_kg REAL,workout_volume REAL,training INTEGER,notes TEXT);CREATE TABLE meals(id INTEGER PRIMARY KEY,date TEXT,meal_group TEXT,name TEXT,calories REAL,protein REAL,fat REAL,carbs REAL,salt_g REAL);');
 for(const f of ['0001_workout_sets.sql','0002_notion_sync.sql'])sqlite.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
 const DB={prepare(sql){let params=[];const q={bind(...v){params=v;return q;},async run(){return {meta:{changes:sqlite.prepare(sql).run(...params).changes}};}};return q;},async batch(qs){sqlite.exec('BEGIN');try{const results=[];for(const q of qs)results.push(await q.run());sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 return {sqlite,DB};
}
const prop=(type,v)=>({type,[type]:v});
function page(kind,id='a'.repeat(32)) {
 const p={};for(const k of ['Calories','Protein','Fat','Carbs','Salt g','PFC Score','Weight kg','Workout Volume kg'])p[k]=prop('number',null);
 p.Date=prop(kind==='daily'?'title':'date',kind==='daily'?[{plain_text:'2026-10-06'}]:{start:'2026-10-06'});p.Day=prop('date',{start:'2026-10-06'});
 p.Name=prop('title',[{plain_text:'Test'}]);p['Meal Group']=prop('select',{name:'朝食'});p.Training=prop('checkbox',true);
 p.Notes=prop('rich_text',[{plain_text:'4セット目: 60kg×13。部分記録。'}]);p.Exercise=prop('rich_text',[{plain_text:'Squat'}]);
 p.Sets=prop('number',4);p['Total Volume kg']=prop('number',1880);
 [20,40,50].forEach((w,i)=>{p[`Set ${i+1} kg`]=prop('number',w);p[`Set ${i+1} reps`]=prop('number',10);});
 return {id,properties:p};
}
test('source parsing includes Notes fourth set, JST dates, zero and validation',()=>{
 const p=page('training');assert.equal(normalize('training',p).payload.volume,1880);assert.equal(normalize('training',p).payload.sets.length,4);
 p.properties.Notes=prop('rich_text',[]);assert.throws(()=>normalize('training',p),/incomplete_sets/);
 const m=page('meal');m.properties.Date.date.start='2026-10-05T16:00:00Z';m.properties.Calories=prop('number',0);
 assert.equal(normalize('meal',m).date,'2026-10-06');assert.equal(normalize('meal',m).payload.calories,0);assert.equal(normalize('meal',m).payload.salt_g,null);
 const d=page('daily');assert.match(normalize('daily',d).payload.notes,/partial/);delete d.properties['PFC Score'];assert.throws(()=>normalize('daily',d),/schema_mismatch/);
});
test('idempotent snapshot preserves originals and handles edit/archive without duplication',async()=>{
 const {sqlite,DB}=setup();sqlite.exec("INSERT INTO meals VALUES(1,'2026-10-06','朝食',NULL,710,NULL,NULL,NULL,NULL);INSERT INTO daily(date,calories,pfc_score) VALUES('2026-10-06',710,32);");
 const before=sqlite.prepare('SELECT * FROM meals').all();const m=page('meal');m.properties.Calories=prop('number',710);
 const l=page('meal','b'.repeat(32));l.properties.Calories=prop('number',910);l.properties['Meal Group']=prop('select',{name:'昼食'});
 const d=page('daily','c'.repeat(32));d.properties.Calories=prop('number',710);d.properties['PFC Score']=prop('number',32);
 const rows=[normalize('meal',m),normalize('meal',l),normalize('daily',d)];await applySnapshot(DB,rows);await applySnapshot(DB,rows);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM notion_records').get().n,3);assert.equal(sqlite.prepare('SELECT calories FROM dashboard_daily').get().calories,1620);
 assert.equal(sqlite.prepare('SELECT pfc_score FROM dashboard_daily').get().pfc_score,32);assert.deepEqual(sqlite.prepare('SELECT * FROM meals').all(),before);
 m.properties.Calories=prop('number',600);await applySnapshot(DB,[normalize('meal',m),normalize('daily',d)]);assert.equal(sqlite.prepare('SELECT SUM(calories) n FROM dashboard_meals').get().n,600);
 await applySnapshot(DB,[]);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM dashboard_meals').get().n,0);assert.deepEqual(sqlite.prepare('SELECT * FROM meals').all(),before);sqlite.close();
});
test('pagination completes before publish and API failure retains last successful data',async()=>{
 const {sqlite,DB}=setup();let calls=0;
 const fetcher=async(url,o)=>{assert.equal(o.headers.Authorization,'Bearer test-secret');assert.equal(o.headers['Notion-Version'],'2025-09-03');calls++;
 const k=Object.keys(SOURCES).find(k=>url.includes(SOURCES[k]));const cursor=JSON.parse(o.body).start_cursor;
 if(k==='meal'&&!cursor)return Response.json({results:[page(k)],has_more:true,next_cursor:'next'});
 return Response.json({results:k==='meal'?[]:[page(k,(k==='daily'?'c':'b').repeat(32))],has_more:false});};
 assert.equal((await syncNotion({DB,NOTION_TOKEN:'test-secret'},fetcher)).status,'ok');assert.equal(calls,4);
 const before=sqlite.prepare('SELECT * FROM notion_records ORDER BY kind').all();
 await assert.rejects(syncNotion({DB,NOTION_TOKEN:'test-secret'},async()=>new Response('private',{status:401})),/notion_http_401/);
 assert.deepEqual(sqlite.prepare('SELECT * FROM notion_records ORDER BY kind').all(),before);const state=sqlite.prepare('SELECT * FROM notion_sync_state').get();assert.equal(state.status,'error');assert.ok(state.last_success);assert.equal(state.lock_until,0);sqlite.close();
});
test('missing secret and overlapping runs do not fetch; expired lock cannot publish',async()=>{
 const {sqlite,DB}=setup();const fail=()=>{throw Error('unexpected fetch');};assert.equal((await syncNotion({DB},fail)).status,'not_configured');
 sqlite.prepare('UPDATE notion_sync_state SET lock_until=?,lock_owner=?').run(Date.now()+600000,'other');assert.equal((await syncNotion({DB,NOTION_TOKEN:'test'},fail)).status,'busy');
 await applySnapshot(DB,[normalize('meal',page('meal'))],'expired');assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM notion_records').get().n,0);sqlite.close();
});
