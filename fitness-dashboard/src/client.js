// Keep the browser program as text: bundlers must not inject Worker-only helpers
// into an inline script. No external scripts or build step for the client.
export const clientScript = String.raw`(function mountDashboard() {
  const $ = id => document.getElementById(id);
  const colors = { calories: '#b5ed8d', protein: '#93c8f0', fat: '#ebd07f', carbs: '#f4a5a9', salt: '#93c8f0', score: '#b5ed8d', volume: '#b5ed8d' };
  const format = (v, digits = 1) => v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('ja-JP', { maximumFractionDigits: digits });
  const valid = v => v != null && Number.isFinite(Number(v));
  const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const short = s => s.slice(5).replace('-', '/');
  const nodes = [];
  let range = ['7', '30', 'all'].includes(new URL(location.href).searchParams.get('range')) ? new URL(location.href).searchParams.get('range') : '7';
  let data, dates = [], controller, exerciseController, requestId = 0, exerciseId = 0;
  let chartSerial = 0;

  async function getJSON(url, signal) {
    const response = await fetch(url, { signal, cache: 'no-store' });
    if (!response.ok) throw new Error('データを取得できませんでした。更新ボタンで再度お試しください。');
    return response.json();
  }

  function timeline(p, rows) {
    const keys = [...new Set(rows.map(v => v.date))].sort();
    if (p.start) {
      const out = [];
      for (let t = Date.parse(p.start + 'T00:00:00Z'), end = Date.parse(p.end + 'T00:00:00Z'); t <= end; t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
      return out;
    }
    // Keep real elapsed time on the x-axis and a gap on unrecorded days.
    if (!keys.length) return [];
    const out = [];
    for (let t = Date.parse(keys[0] + 'T00:00:00Z'), end = Date.parse(keys.at(-1) + 'T00:00:00Z'); t <= end; t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
    return out;
  }

  function values(rows, key, axis = dates) {
    const map = new Map(rows.map(v => [v.date, v[key]]));
    return axis.map(date => valid(map.get(date)) ? Number(map.get(date)) : null);
  }

  function latest(series) {
    for (let i = series.length - 1; i >= 0; i--) if (valid(series[i])) return { value: series[i], date: dates[i] };
    return { value: null, date: null };
  }

  function clearCharts() {
    nodes.splice(0).forEach(n => n.observer.disconnect());
  }

  function chart(parent, config) {
    const { title, unit, description = '', series, band, bars = false, wide = false, bounds, emptyText = 'この期間の記録がありません', axis = dates } = config;
    const card = document.createElement('article');
    card.className = 'card' + (wide ? ' wide' : '');
    const id = 'chart-' + chartSerial++;
    const last = latest(series[0].values);
    card.innerHTML = '<div class="card-head"><div><h3 id="' + id + '-title">' + escape(title) + '</h3><p class="description">' + escape(description) + '</p></div><p class="card-value">' + (series.length === 1 ? format(last.value) + '<small>' + escape(unit) + '</small>' : '') + '</p></div>'
      + '<div class="legend">' + series.map(s => '<span><i class="swatch" style="--color:' + s.color + '"></i>' + escape(s.name) + '</span>').join('') + (band ? '<span><i class="band-key"></i>目標 ' + format(band[0]) + '–' + format(band[1]) + ' ' + escape(unit) + '</span>' : '') + '</div>'
      + '<div class="plot"></div><p class="chart-readout"></p><details class="data-details"><summary>日別データを見る</summary><div class="table-scroll"><table><thead><tr><th scope="col">日付</th>' + series.map(s => '<th scope="col">' + escape(s.name + ' (' + unit + ')') + '</th>').join('') + '</tr></thead><tbody>' + axis.map((dt, i) => '<tr><th scope="row">' + dt + '</th>' + series.map(s => '<td>' + format(s.values[i]) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div></details>';
    parent.append(card);
    const plot = card.querySelector('.plot'), readout = card.querySelector('.chart-readout');
    let selected = Math.max(0, axis.length - 1);
    function report(i) {
      if (!axis.length) { readout.textContent = ''; return; }
      selected = Math.max(0, Math.min(i, axis.length - 1));
      readout.textContent = axis[selected] + ' · ' + series.map(s => s.name + ' ' + format(s.values[selected]) + (valid(s.values[selected]) ? ' ' + unit : '')).join(' / ');
      const cursor = plot.querySelector('.cursor');
      if (cursor) { const x = xAt(selected); cursor.setAttribute('x1', x); cursor.setAttribute('x2', x); cursor.setAttribute('opacity', '1'); }
    }
    let width = 320, left = 45, right = 12;
    const xAt = i => left + (axis.length <= 1 ? (width - left - right) / 2 : i / (axis.length - 1) * (width - left - right));
    function draw() {
      width = Math.max(250, Math.round(plot.getBoundingClientRect().width));
      const height = 200, top = 16, bottom = 27, base = height - bottom, innerH = base - top;
      const nums = series.flatMap(s => s.values).filter(valid).map(Number);
      if (!nums.length) {
        plot.innerHTML = '<div class="empty"><strong>' + escape(emptyText) + '</strong><span>記録が追加されると推移を表示します</span></div>';
        report(selected);
        return;
      }
      let min = bounds ? bounds[0] : 0, max = bounds ? bounds[1] : Math.max(...nums, ...(band || [])) * 1.15;
      if (config.zoom) { min = Math.min(...nums) - 1; max = Math.max(...nums) + 1; }
      if (max <= min) max = min + 1;
      const yAt = v => top + (max - v) / (max - min) * innerH;
      let svg = '';
      for (let tick = 0; tick <= 4; tick++) {
        const v = min + (max - min) * tick / 4, y = yAt(v);
        svg += '<line x1="' + left + '" x2="' + (width - right) + '" y1="' + y + '" y2="' + y + '" stroke="#2b3a30"/><text x="' + (left - 7) + '" y="' + (y + 4) + '" text-anchor="end" fill="#a7b9aa" font-size="10">' + format(v, max > 150 ? 0 : 1) + '</text>';
      }
      if (band) svg += '<rect class="target-band" x="' + left + '" y="' + yAt(band[1]) + '" width="' + (width - left - right) + '" height="' + (yAt(band[0]) - yAt(band[1])) + '" fill="#b5ed8d" fill-opacity=".10"/><path d="M' + left + ',' + yAt(band[0]) + 'H' + (width - right) + 'M' + left + ',' + yAt(band[1]) + 'H' + (width - right) + '" stroke="#b5ed8d" stroke-opacity=".4" stroke-dasharray="3 4"/>';
      // A handful of labels remain legible even for years of data.
      const ticks = [...new Set(Array.from({ length: Math.min(4, axis.length) }, (_, j) => Math.round(j * (axis.length - 1) / Math.max(1, Math.min(4, axis.length) - 1))))];
      ticks.forEach(i => { svg += '<text x="' + xAt(i) + '" y="194" text-anchor="middle" fill="#a7b9aa" font-size="10">' + short(axis[i]) + '</text>'; });
      series.forEach(s => {
        if (bars) {
          const barWidth = Math.max(1, Math.min(24, (width - left - right) / Math.max(axis.length, 1) * .55));
          s.values.forEach((v, i) => { if (valid(v)) svg += '<rect x="' + (xAt(i) - barWidth / 2) + '" y="' + yAt(v) + '" width="' + barWidth + '" height="' + Math.max(0, base - yAt(v)) + '" rx="2" fill="' + s.color + '" fill-opacity=".7"/>'; });
        } else {
          let path = '', pen = false;
          s.values.forEach((v, i) => { if (!valid(v)) { pen = false; return; } path += (pen ? 'L' : 'M') + xAt(i).toFixed(2) + ',' + yAt(v).toFixed(2); pen = true; });
          svg += '<path d="' + path + '" fill="none" stroke="' + s.color + '" stroke-width="2" stroke-linejoin="round"/>';
          s.values.forEach((v, i) => { if (valid(v) && (axis.length <= 60 || !valid(s.values[i - 1]) || !valid(s.values[i + 1]))) svg += '<circle cx="' + xAt(i) + '" cy="' + yAt(v) + '" r="3" fill="' + s.color + '"/>'; });
        }
      });
      svg += '<line class="cursor" x1="' + xAt(selected) + '" x2="' + xAt(selected) + '" y1="' + top + '" y2="' + base + '" stroke="#f0f5ef" stroke-opacity=".45" stroke-dasharray="2 4" opacity="0"/>';
      plot.innerHTML = '<svg viewBox="0 0 ' + width + ' 200" role="img" tabindex="0" aria-labelledby="' + id + '-title" aria-label="' + escape(title + '。タップまたは左右キーで日別の値を確認') + '">' + svg + '</svg>';
      const el = plot.firstElementChild;
      function point(event) {
        const rect = el.getBoundingClientRect(), x = (event.clientX - rect.left) * width / rect.width;
        report(Math.round((x - left) / (width - left - right) * (axis.length - 1)));
      }
      el.addEventListener('pointerdown', point);
      el.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') point(e); });
      el.addEventListener('keydown', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); report(selected + (e.key === 'ArrowLeft' ? -1 : 1)); } });
      report(selected);
    }
    const observer = new ResizeObserver(draw);
    observer.observe(plot);
    nodes.push({ observer, card });
    draw();
  }

  function stat(label, value, unit, note) {
    return '<article class="stat"><p class="stat-label">' + escape(label) + '</p><p class="stat-value">' + format(value) + '<span class="stat-unit">' + escape(unit) + '</span></p><p class="stat-note">' + escape(note) + '</p></article>';
  }

  function render() {
    clearCharts();
    $('nutrition-charts').replaceChildren(); $('body-charts').replaceChildren(); $('exercise-charts').replaceChildren();
    dates = timeline(data.period, [...data.daily, ...data.meals, ...data.workout_days]);
    const d = data.daily, last = d.at(-1), weights = values(d, 'weight_kg'), lastWeight = latest(weights);
    const storedVolume = new Map(d.map(r => [r.date, r.workout_volume]));
    const setVolume = new Map(data.workout_days.map(r => [r.date, r.volume]));
    const volumes = dates.map(date => valid(storedVolume.get(date)) ? Number(storedVolume.get(date)) : valid(setVolume.get(date)) ? Number(setVolume.get(date)) : null);
    const totalVolume = volumes.filter(valid).length ? volumes.reduce((sum, v) => sum + (v || 0), 0) : null;
    $('summary').innerHTML = stat('最新の摂取カロリー', last?.calories, 'kcal', last ? short(last.date) + ' の記録' : 'この期間の記録なし')
      + stat('最新の PFC Score', last?.pfc_score, '/ 100', last ? short(last.date) + ' の記録' : 'この期間の記録なし')
      + stat('最新の体重', lastWeight.value, 'kg', lastWeight.date ? short(lastWeight.date) + ' の記録' : '体重は未記録')
      + stat('期間の総ボリューム', totalVolume, 'kg', '重量 × 回数 の合計');
    const partialDates = d.filter(r => r.notes && /partial|途中|未完/i.test(r.notes)).map(r => short(r.date));
    $('notice').textContent = 'サマリーの最新値は選択期間内の記録です。' + (partialDates.length ? ' ' + partialDates.join('・') + ' は入力途中の記録を含みます。' : '') + ' PFC Score は記録済みの点数を表示します。';
    const allRecordedDates = [...new Set([...d, ...data.meals, ...data.workout_days].map(r => r.date))].sort();
    $('period-label').textContent = data.period.start ? data.period.start + ' – ' + data.period.end : allRecordedDates.length ? allRecordedDates[0] + ' – ' + allRecordedDates.at(-1) : '全期間';
    $('record-count').textContent = '記録 ' + allRecordedDates.length + ' 日';
    const nutrition = $('nutrition-charts'), body = $('body-charts');
    chart(nutrition, { title: 'カロリー', unit: 'kcal', description: '1日の摂取量', band: data.targets.calories, wide: true, series: [{ name: '摂取カロリー', color: colors.calories, values: values(d, 'calories') }] });
    [['protein', 'たんぱく質 / P'], ['fat', '脂質 / F'], ['carbs', '炭水化物 / C']].forEach(([key, title]) => chart(nutrition, { title, unit: 'g', description: '1日の摂取量', band: data.targets[key], series: [{ name: title.split(' / ')[1], color: colors[key], values: values(d, key) }] }));
    chart(nutrition, { title: 'PFC Score', unit: '点', description: '記録済みのスコア · 100点満点', bounds: [0, 100], series: [{ name: 'PFC Score', color: colors.score, values: values(d, 'pfc_score') }] });
    chart(nutrition, { title: '塩分', unit: 'g', description: '1日の塩分摂取量', series: [{ name: '塩分', color: colors.salt, values: values(d, 'salt_g') }] });
    const groups = ['朝食', '昼食', '夕食', '間食'], mealMap = new Map();
    data.meals.forEach(r => {
      const group = /間食|飲み物/.test(r.meal_group) ? '間食' : r.meal_group;
      const key = r.date + '|' + group;
      if (valid(r.calories)) mealMap.set(key, (mealMap.get(key) || 0) + Number(r.calories));
    });
    chart(nutrition, { title: '食事ごとのカロリー', unit: 'kcal', description: '間食には飲み物を含みます · 未記録の食事は空欄', wide: true, series: groups.map((name, i) => ({ name, color: [colors.calories, colors.protein, colors.fat, colors.carbs][i], values: dates.map(date => mealMap.get(date + '|' + name) ?? null) })) });
    chart(body, { title: '体重', unit: 'kg', description: '記録した日の体重', zoom: true, emptyText: '体重はまだ記録されていません', series: [{ name: '体重', color: colors.protein, values: weights }] });
    chart(body, { title: '筋トレ総ボリューム', unit: 'kg', description: '日別の重量 × 回数 の合計', bars: true, series: [{ name: '総ボリューム', color: colors.volume, values: volumes }] });
    const select = $('exercise'), selected = select.value;
    select.replaceChildren();
    if (!data.exercises.length) {
      select.add(new Option('種目の記録がありません', ''));
      select.disabled = true;
      $('exercise-hint').textContent = '種目別の記録が追加されると、重量・回数・ボリュームを確認できます。';
      $('exercise-status').textContent = '';
      renderExercise([]);
    } else {
      data.exercises.forEach(e => select.add(new Option(e.exercise, e.exercise)));
      if (data.exercises.some(e => e.exercise === selected)) select.value = selected;
      select.disabled = false;
      $('exercise-hint').textContent = '重量：その日の最大重量 / 回数：全セットの合計 / ボリューム：重量 × 回数の合計';
      loadExercise();
    }
  }

  function renderExercise(rows) {
    const parent = $('exercise-charts');
    for (let i = nodes.length - 1; i >= 0; i--) if (parent.contains(nodes[i].card)) { nodes[i].observer.disconnect(); nodes.splice(i, 1); }
    parent.replaceChildren();
    [['weight_kg', '重量', 'kg', colors.protein, '1日の最大重量'], ['reps', '回数', '回', colors.fat, '1日の全セット合計'], ['volume', 'ボリューム', 'kg', colors.volume, '重量 × 回数 の合計']].forEach(([key, title, unit, color, description]) => chart(parent, { title, unit, description, emptyText: data.exercises.length ? 'この期間に種目の記録がありません' : '種目別の記録はまだありません', series: [{ name: title, color, values: values(rows, key) }] }));
  }

  async function loadExercise() {
    exerciseController?.abort();
    exerciseController = new AbortController();
    const id = ++exerciseId;
    const parent = $('exercise-charts');
    parent.hidden = true;
    $('exercise-status').textContent = '種目のデータを読み込んでいます…';
    try {
      const result = await getJSON('/api/exercise?' + new URLSearchParams({ range, name: $('exercise').value }), exerciseController.signal);
      if (id !== exerciseId) return;
      renderExercise(result.days);
      $('exercise-status').textContent = result.days.length ? '' : '選択した期間には、この種目の記録がありません。';
      parent.hidden = false;
    } catch (error) {
      if (error.name !== 'AbortError' && id === exerciseId) $('exercise-status').textContent = error.message;
    }
  }

  async function load() {
    controller?.abort(); exerciseController?.abort(); ++exerciseId;
    controller = new AbortController();
    const id = ++requestId;
    $('status').hidden = false; $('status').className = 'status'; $('status').textContent = 'データを読み込んでいます…';
    $('dashboard').hidden = true; $('dashboard').setAttribute('aria-busy', 'true');
    document.querySelectorAll('[data-range]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.range === range)));
    try {
      const result = await getJSON('/api/dashboard?range=' + range, controller.signal);
      if (id !== requestId) return;
      data = result;
      $('dashboard').hidden = false; $('exercise-charts').hidden = false;
      render();
      $('status').hidden = true;
      const url = new URL(location.href); url.searchParams.set('range', range); history.replaceState(null, '', url);
    } catch (error) {
      if (error.name !== 'AbortError' && id === requestId) { $('status').className = 'status error'; $('status').textContent = error.message; }
    } finally {
      if (id === requestId) $('dashboard').setAttribute('aria-busy', 'false');
    }
  }

  document.querySelectorAll('[data-range]').forEach(button => button.addEventListener('click', () => { range = button.dataset.range; load(); }));
  $('refresh').addEventListener('click', load);
  $('exercise').addEventListener('change', loadExercise);
  load();
})();`;
