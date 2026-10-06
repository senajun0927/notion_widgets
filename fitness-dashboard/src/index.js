export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    if (u.pathname === "/api/daily") {
      const { results } = await env.DB.prepare("SELECT * FROM daily ORDER BY date").all();
      return Response.json(results);
    }
    if (u.pathname === "/api/meals") {
      const { results } = await env.DB.prepare("SELECT date, meal_group, SUM(calories) calories FROM meals GROUP BY date, meal_group ORDER BY date").all();
      return Response.json(results);
    }
    return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
};

const page = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fitness Dashboard</title><script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"><\/script><style>body{font-family:system-ui;margin:0;background:#101216;color:#f4f6fa}main{max-width:1000px;margin:auto;padding:22px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.card,canvas{background:#191c23;border-radius:16px;padding:14px}.big{font-size:26px;font-weight:700}.muted{color:#9ca6b4}.chart{height:290px;margin:18px 0}</style></head><body><main><h1>Fitness Dashboard</h1><p class="muted">食事・PFC・塩分・筋トレ</p><div id="summary" class="grid"></div><div class="chart"><canvas id="cal"></canvas></div><div class="chart"><canvas id="pfc"></canvas></div><div class="chart"><canvas id="salt"></canvas></div><div class="chart"><canvas id="workout"></canvas></div><div class="chart"><canvas id="meal"></canvas></div><script>
(async()=>{const d=await fetch('/api/daily').then(r=>r.json()),m=await fetch('/api/meals').then(r=>r.json()),x=d.at(-1)||{};summary.innerHTML=[['今日 kcal',(x.calories||0)+' / 2400'],['PFC Score',(x.pfc_score||0)+' / 100'],['P',(x.protein||0)+'g'],['F',(x.fat||0)+'g'],['C',(x.carbs||0)+'g'],['塩分',x.salt_g==null?'—':x.salt_g+'g']].map(v=>'<div class="card"><div class="muted">'+v[0]+'</div><div class="big">'+v[1]+'</div></div>').join('');const o={responsive:true,maintainAspectRatio:false};new Chart(cal,{type:'line',data:{labels:d.map(v=>v.date),datasets:[{label:'kcal',data:d.map(v=>v.calories)}]},options:o});new Chart(pfc,{type:'line',data:{labels:d.map(v=>v.date),datasets:[{label:'P',data:d.map(v=>v.protein)},{label:'F',data:d.map(v=>v.fat)},{label:'C',data:d.map(v=>v.carbs)}]},options:o});new Chart(salt,{type:'line',data:{labels:d.map(v=>v.date),datasets:[{label:'塩分 g',data:d.map(v=>v.salt_g)}]},options:o});new Chart(workout,{type:'bar',data:{labels:d.map(v=>v.date),datasets:[{label:'筋トレ総ボリューム kg',data:d.map(v=>v.workout_volume)}]},options:o});const dates=[...new Set(m.map(v=>v.date))],groups=['朝食','昼食','夕食','間食・飲み物'];new Chart(meal,{type:'bar',data:{labels:dates,datasets:groups.map(g=>({label:g,data:dates.map(dt=>m.find(v=>v.date===dt&&v.meal_group===g)?.calories||0),stack:'x'}))},options:{...o,scales:{x:{stacked:true},y:{stacked:true}}}})})()
<\/script></main></body></html>`;