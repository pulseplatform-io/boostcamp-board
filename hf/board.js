(() => {
'use strict';

// Табло Boost Camp: публичная страница, цифры читаются из Google Таблицы (gviz CSV).
const SHEET_ID = '1XX1_atKNYadO-DKkujogz7LHgYYMDnIruv8elnIqLYM';
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/edit';
const CSV_URL = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/gviz/tq?tqx=out:csv&headers=1';
const SCRIPT_URL = '/api/board';  // веб-приложение Apps Script (apps-script/Code.gs); пусто — табло только читает таблицу
const API = SCRIPT_URL || CSV_URL;
const POLL_MS = 20000;
const TZ = 'Europe/Istanbul';
const K_SCOPE = 'bc-board-scope';
const K_NAME = 'bc-board-code';
const CONFIG = {"goal": 2500000, "days": [{"date": "2026-10-12", "label": "12 октября", "short": "12 окт", "title": "День 2 · Бизнес и возможности"}, {"date": "2026-10-13", "label": "13 октября", "short": "13 окт", "title": "День 3 · Стратегия и масштаб"}, {"date": "2026-10-14", "label": "14 октября", "short": "14 окт", "title": "День 4 · Pulse Night"}], "teams": [{"id": "sharks", "name": "Акулы", "epithet": "результата", "captain": "Сергей Каныгин", "match": ["акул", "каныгин"]}, {"id": "lions", "name": "Львы", "epithet": "лидерства", "captain": "Александр Цицорин", "match": ["льв", "лев", "цицорин"]}, {"id": "bulls", "name": "Быки", "epithet": "силы", "captain": "Юсуф Завьялов", "match": ["бык", "завьялов"]}, {"id": "whales", "name": "Киты", "epithet": "масштаба", "captain": "Сергей Поляков", "match": ["кит", "поляков"]}]};

const root = document.getElementById('bc-root');
let S = { goal: CONFIG.goal, days: CONFIG.days, teams: CONFIG.teams, values: null, updatedAt: null, updatedBy: null };
let scope = 'all';
let ed = null;
let lastFocus = null;
let log = [];
let loaded = false, loadErr = null, lastSync = null, loading = false;

/* ---------- storage (per-viewer, optional) ---------- */
function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
function ssDel(k) { try { sessionStorage.removeItem(k); } catch (e) {} }
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

/* ---------- format ---------- */
const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const isNum = v => typeof v === 'number' && isFinite(v);
const money = n => isNum(n) ? '$' + nf.format(Math.round(n)) : '—';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pctOf = (f, p) => (p > 0 && isNum(f)) ? f / p * 100 : null;
const pctTxt = v => v == null ? '—' : Math.round(v) + '%';
function plural(n, one, few, many) { const a = Math.abs(n) % 100, b = a % 10; if (a > 10 && a < 20) return many; if (b > 1 && b < 5) return few; if (b === 1) return one; return many; }
function todayISO() {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  catch (e) { return new Date().toISOString().slice(0, 10); }
}
function stamp(iso) {
  if (!iso) return 'ещё не обновлялось';
  try { return new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) + ' по времени Анталии'; }
  catch (e) { return iso; }
}

/* ---------- parsing ---------- */
function parseMoney(raw) {
  if (raw == null) return null;
  let s = String(raw).toLowerCase().replace(/usdt|usd|\$| | /g, ' ').trim();
  if (!s || s === '-' || s === '—' || s === '–') return null;
  let mult = 1;
  const m = s.match(/\s*(млн\.?|тыс\.?|k|к|m|м)$/);
  if (m) { mult = /^(тыс|k|к)/.test(m[1]) ? 1e3 : 1e6; s = s.slice(0, m.index).trim(); }
  s = s.replace(/\s+/g, '');
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
  return Math.round(parseFloat(s) * mult * 100) / 100;
}
function norm(s) { return String(s || '').toLowerCase().replace(/ё/g, 'е'); }
function matchTeam(s) {
  const x = norm(s);
  if (!x.trim()) return null;
  for (const t of S.teams) if ((t.match || []).some(st => x.includes(st))) return t.id;
  return null;
}
function matchDay(s) {
  const x = norm(s).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(x)) { const d = S.days.find(dd => dd.date === x); return d ? d.date : null; }
  const m = x.match(/^(\d{1,2})(?:[.\/-](\d{1,2}))?(?:[.\/-]\d{2,4})?(?:\s*окт\S*)?$/);
  if (!m) return null;
  const d = S.days.find(dd => +dd.date.slice(8) === +m[1] && (!m[2] || +m[2] === 10));
  return d ? d.date : null;
}
function parsePaste(text, defDate) {
  const out = { ok: [], bad: [] };
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    let cols;
    if (raw.includes('\t')) cols = raw.split('\t');
    else if (line.includes(';')) cols = line.split(';');
    else if (line.includes('|')) cols = line.split('|');
    else {
      cols = line.split(/\s{2,}/);
      if (cols.length === 1) {
        const tok = line.split(/\s+/);
        const nums = tok.slice(1);
        if (nums.length > 3) { out.bad.push({ n: i + 1, line, why: 'разделите колонки табуляцией или «;»' }); return; }
        cols = tok;
      }
    }
    cols = cols.map(c => c.trim());
    const tid = matchTeam(cols[0]);
    if (!tid) { if (/план|факт|команд/i.test(line)) return; out.bad.push({ n: i + 1, line, why: 'не узнал команду' }); return; }
    let rest = cols.slice(1);
    let date = defDate;
    if (rest.length >= 3) {
      const d = matchDay(rest[0]);
      if (!d) { out.bad.push({ n: i + 1, line, why: 'дата должна быть 12, 13 или 14' }); return; }
      date = d; rest = rest.slice(1);
    }
    if (!rest.length || rest.every(c => c === '')) { out.bad.push({ n: i + 1, line, why: 'нет чисел' }); return; }
    const plan = rest[0] === undefined || rest[0] === '' ? undefined : parseMoney(rest[0]);
    const fact = rest[1] === undefined || rest[1] === '' ? undefined : parseMoney(rest[1]);
    if (Number.isNaN(plan) || Number.isNaN(fact)) { out.bad.push({ n: i + 1, line, why: 'не разобрал число' }); return; }
    out.ok.push({ tid, date, plan, fact });
  });
  return out;
}

/* ---------- data ---------- */
function blankValues(data) {
  const src = data || S, v = {};
  for (const t of src.teams) { v[t.id] = {}; for (const d of src.days) v[t.id][d.date] = { plan: null, fact: null }; }
  return v;
}
function normalize(data) {
  const v = blankValues(data);
  for (const t of data.teams) for (const d of data.days) {
    const c = ((data.values || {})[t.id] || {})[d.date] || {};
    v[t.id][d.date] = { plan: isNum(c.plan) ? c.plan : null, fact: isNum(c.fact) ? c.fact : null };
  }
  data.values = v;
  data.goal = isNum(data.goal) ? data.goal : 0;
  return data;
}
const cell = (tid, date) => S.values[tid][date];
function sum(arr) { let s = null; for (const v of arr) if (isNum(v)) s = (s || 0) + v; return s; }
function teamAgg(tid, dates) { return { plan: sum(dates.map(d => cell(tid, d).plan)), fact: sum(dates.map(d => cell(tid, d).fact)) }; }
function dayAgg(date) { return { plan: sum(S.teams.map(t => cell(t.id, date).plan)), fact: sum(S.teams.map(t => cell(t.id, date).fact)) }; }
const allDates = () => S.days.map(d => d.date);
const scopeDates = () => scope === 'all' ? allDates() : [scope];
function dayState(date) { const t = todayISO(); return date < t ? 'past' : date === t ? 'now' : 'future'; }
const dayOf = date => S.days.find(d => d.date === date);
function hasAnyData() { return S.teams.some(t => S.days.some(d => { const c = cell(t.id, d.date); return isNum(c.plan) || isNum(c.fact); })); }

/* ---------- pieces ---------- */
function chip(plan, fact) {
  if (!isNum(plan) && !isNum(fact)) return '<span class="chip mute">нет данных</span>';
  if (!isNum(fact)) return '<span class="chip mute">ждём факт</span>';
  if (!(plan > 0)) return '<span class="chip">без плана</span>';
  const p = fact / plan * 100;
  if (p >= 100) return '<span class="chip ok">план выполнен · ' + Math.round(p) + '%</span>';
  return '<span class="chip">' + Math.round(p) + '% плана</span>';
}
function bar(plan, fact, max, label) {
  if (!(max > 0) || (!(plan > 0) && !(fact > 0))) return '<div class="bar" role="img" aria-label="' + esc(label + ': данных нет') + '"></div>';
  const w = v => Math.max(0, Math.min(100, (v || 0) / max * 100)).toFixed(2);
  const tip = 'Факт ' + money(fact) + ' · план ' + money(plan);
  let h = '<div class="bar" role="img" aria-label="' + esc(label + ': ' + tip) + '" title="' + esc(tip) + '">';
  if (plan > 0) h += '<span class="pl" style="width:' + w(plan) + '%"></span>';
  if (fact > 0) h += '<span class="fa" style="width:' + w(fact) + '%"></span>';
  if (plan > 0) h += '<span class="tk" style="left:' + w(plan) + '%"></span>';
  return h + '</div>';
}
function legend() { return '<div class="legend" aria-hidden="true"><span><i class="lg-f"></i>факт</span><span><i class="lg-p"></i>план</span><span><i class="lg-t"></i>отметка плана</span></div>'; }

/* ---------- views ---------- */
const num = v => (v === null || v === undefined || v === '') ? null : (isFinite(+v) ? +v : null);
function applyServer(j) {
  const v = blankValues(S);
  let upd = null, by = null;
  for (const r of (j.rows || [])) {
    if (!v[r.team_id] || !v[r.team_id][r.day]) continue;
    v[r.team_id][r.day] = { plan: num(r.plan), fact: num(r.fact) };
    if (r.updated_at && (!upd || r.updated_at > upd)) { upd = r.updated_at; by = r.updated_by || null; }
  }
  if (j.goal && isNum(+j.goal.value)) { S.goal = +j.goal.value; if (j.goal.updated_at && (!upd || j.goal.updated_at > upd)) { upd = j.goal.updated_at; by = j.goal.updated_by || null; } }
  S.values = v; S.updatedAt = upd; S.updatedBy = by;
  log = Array.isArray(j.log) ? j.log : [];
}
async function load() {
  if (loading) return;
  loading = true;
  try {
    const r = await fetch(API + (API.includes('?') ? '&' : '?') + '_=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const text = await r.text();
    if (/^\s*</.test(text)) throw new Error('таблица закрыта');
    applyServer(SCRIPT_URL ? JSON.parse(text) : fromCsv(text));
    loaded = true; loadErr = null; lastSync = new Date();
  } catch (e) { loadErr = e; }
  loading = false;
  renderMain();
}
function parseCsv(t) {
  const out = []; let row = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(f); out.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); out.push(row); }
  return out;
}
function sheetDay(s) {
  const n = (String(s || '').match(/\d+/g) || []).map(Number).find(x => x >= 12 && x <= 14);
  const d = n && S.days.find(dd => +dd.date.slice(8) === n);
  return d ? d.date : null;
}
function fromCsv(text) {
  const rows = [], j = { rows, goal: null, log: [] };
  parseCsv(text).slice(1).forEach(c => {
    const name = norm(c[0]);
    if (name.includes('цель')) { const g = parseMoney(c[3]); if (isNum(g) && g > 0) j.goal = { value: g }; return; }
    const tid = matchTeam(c[0]), day = sheetDay(c[2]);
    if (!tid || !day) return;
    const plan = parseMoney(c[3]), fact = parseMoney(c[4]);
    rows.push({ team_id: tid, day, plan: Number.isNaN(plan) ? null : plan, fact: Number.isNaN(fact) ? null : fact });
  });
  return j;
}
function syncText() {
  if (!lastSync) return loadErr ? 'нет связи с базой' : 'загружаю…';
  const t = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(lastSync);
  return (loadErr ? 'нет связи · последние данные от ' : 'синхронизировано в ') + t;
}

function renderMain() {
  if (!S.values) S.values = blankValues(S);
  const t = todayISO();
  const segs = [['all', 'Все дни']].concat(S.days.map(d => [d.date, d.short]));
  const y = window.scrollY;
  let h = '<div class="wrap">';
  h += '<header class="top"><span class="logo" role="img" aria-label="Pulse Platform"></span><div class="top-r"><span class="crumb">Boost Camp · Кемер</span>' +
    '<span class="sync' + (loadErr ? ' bad' : '') + '" role="status">' + esc(syncText()) + '</span>' +
    '<button class="btn btn-sm" id="b-sync" type="button">Обновить</button>' +
    (SCRIPT_URL ? '<button class="btn btn-o btn-sm" id="b-edit" type="button"' + (loaded ? '' : ' disabled') + '>Внести данные</button>' : '<a class="btn btn-o btn-sm" href="' + SHEET_URL + '" target="_blank" rel="noopener">Внести данные</a>') + '</div></header>';

  if (loadErr && !loaded) h += '<div class="banner" role="alert"><span>Не получилось загрузить цифры из таблицы. Проверьте интернет и нажмите «Обновить». Если не помогает — у таблицы не открыт доступ по ссылке.</span></div>';
  else if (loadErr) h += '<div class="banner" role="alert"><span>Связь с базой пропала. На экране последние загруженные цифры, табло обновится само.</span></div>';
  else if (loaded && !hasAnyData()) h += '<div class="banner" role="status"><span>Данных пока нет. Нажмите «Внести данные», чтобы добавить план и факт команд.</span>' + (SCRIPT_URL ? '<button class="btn btn-o btn-sm" id="b-edit-2" type="button">Внести данные</button>' : '<a class="btn btn-o btn-sm" href="' + SHEET_URL + '" target="_blank" rel="noopener">Открыть таблицу</a>') + '</div>';

  h += '<section class="head"><div><h1>План и факт команд</h1><p>12–14 октября · четыре команды · суммы в долларах</p></div>' +
    '<div class="seg" role="group" aria-label="Период">' + segs.map(([k, l]) => '<button type="button" data-scope="' + k + '" aria-pressed="' + (scope === k) + '">' + esc(l) + (k === t ? '<span class="dot" title="сегодня"></span>' : '') + '</button>').join('') + '</div></section>';

  h += heroHtml() + kpiHtml() + teamsHtml() + daysHtml() + tableHtml() + (SCRIPT_URL ? logHtml() : '');

  h += '<footer class="foot"><span>Цель <b>' + money(S.goal) + '</b> — слайд «Цель этого Boost Camp» из презентации BOOSTCAMP_1_GO от 11 октября.</span>' +
    '<span>План и факт вносят организаторы и капитаны в <a href="' + SHEET_URL + '" target="_blank" rel="noopener" style="color:var(--fg-2)">Google Таблицу</a>. История правок — в самой таблице: Файл → История версий.</span>' +
    '<span>Табло обновляется само каждые 20 секунд.</span></footer>';
  h += '</div>';
  root.innerHTML = h;
  window.scrollTo(0, y);

  root.querySelectorAll('[data-scope]').forEach(b => b.addEventListener('click', () => { scope = b.dataset.scope; lsSet(K_SCOPE, scope); renderMain(); }));
  const be = document.getElementById('b-edit'); if (be) be.addEventListener('click', () => openEditor());
  const be2 = document.getElementById('b-edit-2'); if (be2) be2.addEventListener('click', () => openEditor());
  document.getElementById('b-sync').addEventListener('click', () => load());
}

function heroHtml() {
  const goal = S.goal || 0;
  const facts = S.days.map(d => dayAgg(d.date).fact || 0);
  const total = facts.reduce((a, b) => a + b, 0);
  const p = goal > 0 ? total / goal * 100 : null;
  const left = Math.max(0, goal - total);
  let acc = 0, segs = '';
  if (goal > 0) facts.forEach((f, i) => { if (f > 0 && acc < 100) { const w = Math.min(f / goal * 100, 100 - acc); acc += w; segs += '<i class="d' + (i + 1) + '" style="width:' + w.toFixed(2) + '%" title="' + esc(S.days[i].label + ': ' + money(f)) + '"></i>'; } });
  const t = todayISO();
  const remain = S.days.filter(d => d.date > t || (d.date === t && !isNum(dayAgg(d.date).fact))).length;
  let note;
  if (!(goal > 0)) note = 'Цель кемпа не задана.';
  else if (total >= goal) note = 'Цель кемпа взята: на ' + money(total - goal) + ' больше плана.';
  else if (total === 0) note = 'Факт ещё не внесён. Цель — ' + money(goal) + ' за три дня.';
  else if (remain > 1) note = 'До цели ' + money(left) + ': это ' + money(left / remain) + ' в день на оставшиеся ' + remain + ' ' + plural(remain, 'день', 'дня', 'дней') + '.';
  else if (remain === 1) note = 'До цели ' + money(left) + ' — их нужно добрать за последний день.';
  else if (S.days[S.days.length - 1].date === t) note = 'Последний день кемпа: до цели ' + money(left) + '.';
  else note = 'Кемп завершён. До цели не хватило ' + money(left) + '.';
  return '<section class="hero" aria-label="Путь к цели кемпа">' +
    '<div><div class="eyebrow">Цель Boost Camp · все дни</div><div class="big num">' + money(total) + '</div><div class="of num">из ' + money(goal) + '</div></div>' +
    '<div class="pct num">' + pctTxt(p) + '<small>цели выполнено</small></div>' +
    '<div class="hero-bar"><div class="gbar" role="img" aria-label="' + esc('Факт ' + money(total) + ' из ' + money(goal)) + '">' + segs + '</div>' +
    '<div class="hero-legend num">' + S.days.map((d, i) => '<span><i class="sw d' + (i + 1) + '"></i>' + esc(d.short) + ' <b>' + money(dayAgg(d.date).fact) + '</b></span>').join('') + '</div></div>' +
    '<p class="hero-note">' + esc(note) + '</p></section>';
}

function kpiHtml() {
  const ds = scopeDates();
  const plan = sum(S.teams.map(t => teamAgg(t.id, ds).plan));
  const fact = sum(S.teams.map(t => teamAgg(t.id, ds).fact));
  const p = pctOf(fact, plan);
  const diff = (isNum(plan) && isNum(fact)) ? fact - plan : null;
  const lbl = scope === 'all' ? 'за три дня' : dayOf(scope).label;
  let planSub = lbl;
  if (scope === 'all') {
    const t = todayISO();
    const toDate = sum(S.teams.map(tm => teamAgg(tm.id, allDates().filter(d => d <= t)).plan));
    if (isNum(toDate) && S.days.some(d => d.date > t) && S.days.some(d => d.date <= t)) planSub = 'по плану на сегодня ' + money(toDate);
  }
  const tile = (k, v, s, o) => '<div class="kpi"><div class="k">' + k + '</div><div class="v num' + (o ? ' o' : '') + '">' + v + '</div><div class="s num">' + esc(s) + '</div></div>';
  return '<section class="kpis" aria-label="Сводка за период">' +
    tile('План', money(plan), planSub) +
    tile('Факт', money(fact), 'все четыре команды', true) +
    tile('Выполнение', pctTxt(p), p == null ? 'нужны план и факт' : p >= 100 ? 'план выполнен' : 'осталось ' + money(plan - fact)) +
    tile('Разница с планом', diff == null ? '—' : (diff >= 0 ? '+' : '−') + money(Math.abs(diff)), diff == null ? '—' : diff >= 0 ? 'выше плана' : 'ниже плана') +
    '</section>';
}

function teamsHtml() {
  const ds = scopeDates();
  const rows = S.teams.map(t => Object.assign({ t }, teamAgg(t.id, ds)));
  const max = Math.max(0, ...rows.map(r => Math.max(r.plan || 0, r.fact || 0)));
  const sorted = rows.slice().sort((a, b) => ((b.fact ?? -1) - (a.fact ?? -1)) || ((pctOf(b.fact, b.plan) ?? -1) - (pctOf(a.fact, a.plan) ?? -1)));
  const lead = sorted[0];
  const done = rows.filter(r => r.plan > 0 && isNum(r.fact) && r.fact >= r.plan).length;
  const withPlan = rows.filter(r => r.plan > 0 && isNum(r.fact)).length;
  let say = 'Рейтинг появится, когда будет внесён факт.';
  if (lead && lead.fact > 0) {
    const lp = pctOf(lead.fact, lead.plan);
    say = 'Лидируют ' + lead.t.name + ': ' + money(lead.fact) + (lp != null ? ', ' + Math.round(lp) + '% плана' : '') + '.';
    if (withPlan) say += ' План выполнили ' + done + ' из ' + withPlan + '.';
  }
  let h = '<section class="sec" aria-labelledby="h-teams"><div class="sec-h"><h2 id="h-teams">Команды' + (scope === 'all' ? '' : ' · ' + esc(dayOf(scope).label)) + '</h2>' + legend() + '</div><p class="say">' + esc(say) + '</p><div class="board">';
  sorted.forEach((r, i) => {
    const rank = r.fact > 0 ? i + 1 : null;
    const mcls = rank && rank <= 3 ? 'm' + rank : 'm0';
    let mini = '';
    if (scope === 'all') mini = '<div class="days-mini num">' + S.days.map(d => '<span>' + esc(d.short) + ' <b>' + money(cell(r.t.id, d.date).fact) + '</b></span>').join('') + '</div>';
    h += '<div class="team"><div class="medal ' + mcls + ' num" aria-label="' + (rank ? rank + ' место' : 'без места') + '">' + (rank || '–') + '</div>' +
      '<div><div class="tname">' + esc(r.t.name) + ' <em>' + esc(r.t.epithet || '') + '</em></div><div class="tcap">Капитан — ' + esc(r.t.captain) + '</div></div>' +
      '<div class="tbar">' + bar(r.plan, r.fact, max, r.t.name) + mini + '</div>' +
      '<div class="tnums num"><div class="f">' + money(r.fact) + '</div><div class="p">план ' + money(r.plan) + '</div>' + chip(r.plan, r.fact) + '</div></div>';
  });
  return h + '</div></section>';
}

function daysHtml() {
  const aggs = S.days.map(d => Object.assign({ d }, dayAgg(d.date)));
  const max = Math.max(0, ...aggs.map(a => Math.max(a.plan || 0, a.fact || 0)));
  const scored = aggs.filter(a => pctOf(a.fact, a.plan) != null);
  let say = 'Дни заполняются по мере внесения факта.';
  if (scored.length) {
    const best = scored.slice().sort((a, b) => pctOf(b.fact, b.plan) - pctOf(a.fact, a.plan))[0];
    say = scored.length === 1
      ? best.d.label + ': ' + Math.round(pctOf(best.fact, best.plan)) + '% дневного плана по всем командам.'
      : 'Сильнее всего к плану — ' + best.d.label + ': ' + Math.round(pctOf(best.fact, best.plan)) + '%.';
  }
  let h = '<section class="sec" aria-labelledby="h-days"><div class="sec-h"><h2 id="h-days">По дням</h2>' + legend() + '</div><p class="say">' + esc(say) + '</p><div class="days">';
  aggs.forEach(a => {
    const st = dayState(a.d.date);
    const stChip = st === 'now' ? '<span class="chip now">сегодня</span>' : st === 'past' ? '<span class="chip mute">прошёл</span>' : '<span class="chip mute">впереди</span>';
    const p = pctOf(a.fact, a.plan);
    const teams = S.teams.map(t => Object.assign({ t }, cell(t.id, a.d.date))).filter(x => isNum(x.fact));
    let best = '';
    if (teams.length) {
      const b = teams.slice().sort((x, y) => ((pctOf(y.fact, y.plan) ?? -1) - (pctOf(x.fact, x.plan) ?? -1)) || (y.fact - x.fact))[0];
      const bp = pctOf(b.fact, b.plan);
      best = '<div class="best">Лучше всех: <b>' + esc(b.t.name) + '</b> — ' + (bp != null ? Math.round(bp) + '% плана' : money(b.fact)) + '</div>';
    }
    h += '<article class="day' + (st === 'now' ? ' is-now' : '') + '"><div class="dh"><div><div class="dd">' + esc(a.d.label) + '</div><div class="dt">' + esc(a.d.title) + '</div></div>' + stChip + '</div>' +
      '<div class="row num"><span class="f">' + money(a.fact) + '</span><span class="pp' + (p == null ? ' dim' : '') + '">' + pctTxt(p) + '</span></div>' +
      '<div class="sub num">план ' + money(a.plan) + (isNum(a.plan) && isNum(a.fact) ? ' · ' + (a.fact >= a.plan ? '+' : '−') + money(Math.abs(a.fact - a.plan)) : '') + '</div>' +
      bar(a.plan, a.fact, max, a.d.label) + best + '</article>';
  });
  return h + '</div></section>';
}

function tableHtml() {
  const t = todayISO();
  const cellH = (plan, fact) => { const p = pctOf(fact, plan); return '<div class="f">' + money(fact) + '</div><div class="p">план ' + money(plan) + '</div><div class="pc' + (p != null && p >= 100 ? ' ok' : '') + '">' + pctTxt(p) + '</div>'; };
  let h = '<section class="sec" aria-labelledby="h-tbl"><div class="sec-h"><h2 id="h-tbl">Таблица план/факт</h2><p class="say">Все цифры по командам и дням</p></div><div class="tbl-wrap"><table><thead><tr><th scope="col">Команда</th>' +
    S.days.map(d => '<th scope="col"' + (d.date === t ? ' class="now"' : '') + '>' + esc(d.short) + (d.date === t ? ' · сегодня' : '') + '</th>').join('') + '<th scope="col">Итого</th></tr></thead><tbody>';
  S.teams.forEach(tm => {
    const tot = teamAgg(tm.id, allDates());
    h += '<tr><td class="tn">' + esc(tm.name) + '<small>' + esc(tm.captain) + '</small></td>' + S.days.map(d => { const c = cell(tm.id, d.date); return '<td>' + cellH(c.plan, c.fact) + '</td>'; }).join('') + '<td>' + cellH(tot.plan, tot.fact) + '</td></tr>';
  });
  const all = { plan: sum(S.days.map(d => dayAgg(d.date).plan)), fact: sum(S.days.map(d => dayAgg(d.date).fact)) };
  h += '</tbody><tfoot><tr><td class="tn">Все команды</td>' + S.days.map(d => { const a = dayAgg(d.date); return '<td>' + cellH(a.plan, a.fact) + '</td>'; }).join('') + '<td>' + cellH(all.plan, all.fact) + '</td></tr></tfoot></table></div></section>';
  return h;
}

function logHtml() {
  if (!log.length) return '';
  const tn = id => (S.teams.find(t => t.id === id) || {}).name || id;
  const tm = iso => { try { return new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); } catch (e) { return iso; } };
  const ch = (k, o, n) => (o ?? null) === (n ?? null) ? '' : '<span>' + k + ' ' + money(num(o)) + ' → <b>' + money(num(n)) + '</b></span>';
  let h = '<section class="sec" aria-labelledby="h-log"><div class="sec-h"><h2 id="h-log">Последние изменения</h2><p class="say">Кто и что вносил — на случай ошибки</p></div><ol class="log">';
  log.slice(0, 12).forEach(e => {
    const what = e.team_id === '_goal' ? '<span>цель ' + money(num(e.plan_old)) + ' → <b>' + money(num(e.plan_new)) + '</b></span>'
      : '<b>' + esc(tn(e.team_id)) + '</b> · ' + esc((dayOf(e.day) || {}).short || e.day) + ' ' + ch('план', e.plan_old, e.plan_new) + ' ' + ch('факт', e.fact_old, e.fact_new);
    h += '<li><span class="lt num">' + esc(tm(e.at)) + '</span><span class="lw">' + esc(e.updated_by || 'без имени') + '</span><span class="lc num">' + what + '</span></li>';
  });
  return h + '</ol></section>';
}

/* ---------- editor ---------- */
function edFrom(src) {
  const values = JSON.parse(JSON.stringify((src && src.values) || S.values));
  const base = blankValues();
  for (const t of S.teams) for (const d of S.days) {
    const c = ((values[t.id] || {})[d.date]) || {};
    base[t.id][d.date] = { plan: isNum(c.plan) ? c.plan : null, fact: isNum(c.fact) ? c.fact : null };
  }
  const t = todayISO();
  return { day: dayOf(t) ? t : S.days[0].date, values: base, goal: isNum(src && src.goal) ? src.goal : S.goal, bad: {}, report: '' };
}
function edField(tid, date, k, label) {
  const id = 'ed-' + tid + '-' + date + '-' + k;
  const v = ed.values[tid][date][k];
  return '<div class="field"><label for="' + id + '">' + label + ', $</label><input class="inp num" id="' + id + '" inputmode="decimal" autocomplete="off" data-t="' + tid + '" data-d="' + date + '" data-k="' + k + '" value="' + (isNum(v) ? nf.format(v) : '') + '" placeholder="0"><div class="hint" id="' + id + '-h"></div></div>';
}
function edRows() {
  const d = ed.day;
  return S.teams.map(t => '<div class="ed-row"><div class="who"><div class="tname">' + esc(t.name) + '</div><div class="tcap">' + esc(t.captain) + '</div></div>' + edField(t.id, d, 'plan', 'План') + edField(t.id, d, 'fact', 'Факт') + '</div>').join('');
}
function evenShare() { return ed.goal > 0 ? Math.round(ed.goal / S.teams.length / S.days.length) : 0; }

function openEditor() {
  if (!S.values || !loaded) return;
  if (!ed) ed = edFrom(null);
  lastFocus = document.activeElement;
  let host = document.getElementById('bc-editor');
  if (!host) { host = document.createElement('div'); host.id = 'bc-editor'; document.body.appendChild(host); }
  host.innerHTML =
    '<div class="scrim" id="ed-scrim"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="ed-title">' +
    '<div class="sh-h"><h2 id="ed-title">Внести данные</h2><button class="btn btn-sm" id="ed-x" type="button">Закрыть</button></div>' +
    '<div class="sh-b">' +
      '<div class="field"><label for="ed-code">Код доступа</label><input class="inp" id="ed-code" type="password" autocomplete="current-password" autocapitalize="off" spellcheck="false" placeholder="Выдаёт Дмитрий" value="' + esc(lsGet(K_NAME) || '') + '"><div class="hint">Вносить цифры могут только владельцы кода. На этом устройстве код запомнится.</div></div>' +
      '<div class="ed-head"><div class="field"><label for="ed-goal">Цель кемпа за три дня, $</label><input class="inp num" id="ed-goal" inputmode="decimal" autocomplete="off" value="' + (isNum(ed.goal) ? nf.format(ed.goal) : '') + '"><div class="hint" id="ed-goal-h"></div></div></div>' +
      '<div class="seg" role="group" aria-label="День" id="ed-days">' + S.days.map(d => '<button type="button" data-edday="' + d.date + '" aria-pressed="' + (d.date === ed.day) + '">' + esc(d.short) + '</button>').join('') + '</div>' +
      '<div class="ed-grid" id="ed-grid">' + edRows() + '</div>' +
      '<div class="helper"><button class="btn btn-sm" id="ed-even" type="button">Заполнить пустые планы поровну</button><span class="num" id="ed-even-n">по ' + money(evenShare()) + ' на команду в день</span></div>' +
      '<details id="ed-paste-box"><summary>Вставить из таблицы</summary><div class="det-b">' +
        '<p>Скопируйте строки из Google Таблиц или напишите по строке на команду: <code>Акулы; 250 000; 180 000</code> — план и факт для выбранного дня. Чтобы указать день, добавьте его после команды: <code>Киты; 13; 300к; 320к</code>. Команду можно назвать фамилией капитана. Пустая ячейка не меняет значение.</p>' +
        '<label class="hint" for="ed-paste" style="color:var(--label);font-weight:600;font-size:13px">Строки для вставки</label><textarea class="inp" id="ed-paste" spellcheck="false"></textarea>' +
        '<div class="helper"><button class="btn btn-sm" id="ed-parse" type="button">Разобрать и подставить</button></div><div id="ed-report"></div>' +
      '</div></details>' +
    '</div>' +
    '<div class="sh-f"><p class="status" id="ed-status" role="status" aria-live="polite">Сохранение сразу видно всем, у кого открыто табло.</p>' +
      '<div class="acts"><button class="btn" id="ed-cancel" type="button">Отменить изменения</button><button class="btn btn-o" id="ed-save" type="button">Сохранить для всех</button></div></div>' +
    '</div></div>';

  const grid = document.getElementById('ed-grid');
  grid.addEventListener('input', onCellInput);
  grid.addEventListener('focusout', onCellBlur);
  document.getElementById('ed-goal').addEventListener('input', e => {
    const v = parseMoney(e.target.value), h = document.getElementById('ed-goal-h');
    if (Number.isNaN(v)) { h.textContent = 'Не похоже на число'; h.className = 'hint bad'; ed.bad.goal = true; }
    else { ed.goal = v == null ? 0 : v; delete ed.bad.goal; h.textContent = v == null ? '' : '= ' + money(v); h.className = 'hint'; }
    document.getElementById('ed-even-n').textContent = 'по ' + money(evenShare()) + ' на команду в день';
  });
  document.querySelectorAll('[data-edday]').forEach(b => b.addEventListener('click', () => {
    ed.day = b.dataset.edday;
    document.querySelectorAll('[data-edday]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.edday === ed.day)));
    grid.innerHTML = edRows();
  }));
  document.getElementById('ed-even').addEventListener('click', () => {
    const n = evenShare(); if (!(n > 0)) return;
    let c = 0;
    for (const t of S.teams) for (const d of S.days) if (!isNum(ed.values[t.id][d.date].plan)) { ed.values[t.id][d.date].plan = n; c++; }
    grid.innerHTML = edRows();
    setStatus(c ? 'Заполнено пустых планов: ' + c + '. Проверьте и сохраните.' : 'Пустых планов нет — ничего не изменилось.');
  });
  document.getElementById('ed-parse').addEventListener('click', () => {
    const res = parsePaste(document.getElementById('ed-paste').value, ed.day);
    res.ok.forEach(r => { const c = ed.values[r.tid][r.date]; if (r.plan !== undefined) c.plan = r.plan; if (r.fact !== undefined) c.fact = r.fact; });
    grid.innerHTML = edRows();
    let rep = '';
    if (res.ok.length) rep += '<p>Подставлено строк: ' + res.ok.length + '. Проверьте значения по дням и сохраните.</p>';
    if (res.bad.length) rep += '<ul class="plist">' + res.bad.map(b => '<li class="bad">Строка ' + b.n + ': ' + esc(b.why) + ' — «' + esc(b.line.slice(0, 60)) + '»</li>').join('') + '</ul>';
    if (!res.ok.length && !res.bad.length) rep = '<p>Вставьте строки в поле выше.</p>';
    document.getElementById('ed-report').innerHTML = rep;
  });
  document.getElementById('ed-x').addEventListener('click', () => closeEditor());
  document.getElementById('ed-cancel').addEventListener('click', () => { ed = null; closeEditor(); });
  document.getElementById('ed-save').addEventListener('click', save);
  document.getElementById('ed-scrim').addEventListener('click', e => { if (e.target.id === 'ed-scrim') closeEditor(); });
  document.addEventListener('keydown', onEsc);
  try { document.getElementById('ed-goal').focus({ preventScroll: true }); } catch (e) {}
}
function onEsc(e) { if (e.key === 'Escape' && document.getElementById('bc-editor')) closeEditor(); }
function closeEditor(silent) {
  const host = document.getElementById('bc-editor');
  if (host) host.remove();
  document.removeEventListener('keydown', onEsc);
  if (!silent && lastFocus && document.body.contains(lastFocus)) { try { lastFocus.focus(); } catch (e) {} }
}
function onCellInput(e) {
  const el = e.target; if (!el.dataset || !el.dataset.k) return;
  const v = parseMoney(el.value), h = document.getElementById(el.id + '-h'), key = el.id;
  if (Number.isNaN(v)) { h.textContent = 'Не похоже на число'; h.className = 'hint bad'; ed.bad[key] = true; return; }
  delete ed.bad[key];
  ed.values[el.dataset.t][el.dataset.d][el.dataset.k] = v;
  h.textContent = v == null ? '' : '= ' + money(v); h.className = 'hint';
}
function onCellBlur(e) {
  const el = e.target; if (!el.dataset || !el.dataset.k || ed.bad[el.id]) return;
  const v = ed.values[el.dataset.t][el.dataset.d][el.dataset.k];
  el.value = isNum(v) ? nf.format(v) : '';
}
function setStatus(msg, bad) { const s = document.getElementById('ed-status'); if (s) { s.textContent = msg; s.className = 'status' + (bad ? ' bad' : ''); } }

let saving = false;
async function save() {
  if (saving || !ed) return;
  if (Object.keys(ed.bad).length) { setStatus('Исправьте поля с ошибкой — они подсвечены красным.', true); return; }
  const codeEl = document.getElementById('ed-code');
  const code = (codeEl ? codeEl.value : '').trim();
  if (!code) { setStatus('Введите код доступа — без него сохранить нельзя.', true); return; }
  const entries = [];
  for (const t of S.teams) for (const d of S.days) {
    const was = S.values[t.id][d.date], now = ed.values[t.id][d.date], e = { team_id: t.id, day: d.date };
    if ((was.plan ?? null) !== (now.plan ?? null)) e.plan = now.plan ?? null;
    if ((was.fact ?? null) !== (now.fact ?? null)) e.fact = now.fact ?? null;
    if ('plan' in e || 'fact' in e) entries.push(e);
  }
  const body = { code, entries };
  if (isNum(ed.goal) && ed.goal !== S.goal) body.goal = ed.goal;
  if (!entries.length && !('goal' in body)) { setStatus('Изменений нет — сохранять нечего.'); return; }
  saving = true;
  const btn = document.getElementById('ed-save'); if (btn) btn.disabled = true;
  setStatus('Сохраняю…');
  try {
    const r = await fetch(SCRIPT_URL, { method: 'POST', body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
    lsSet(K_NAME, code);
    applyServer(j); loaded = true; loadErr = null; lastSync = new Date();
    ed = null; closeEditor(); renderMain();
    toast('Сохранено: ' + (entries.length ? entries.length + ' ' + plural(entries.length, 'ячейка', 'ячейки', 'ячеек') : 'цель'));
  } catch (e) {
    setStatus('Не удалось сохранить: ' + (e && e.message ? e.message : 'нет связи') + '. Цифры в форме остались — попробуйте ещё раз.', true);
  }
  saving = false; if (btn) btn.disabled = false;
}
function toast(msg) {
  const el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); el.textContent = msg;
  document.body.appendChild(el); setTimeout(() => el.remove(), 3200);
}

/* ---------- boot ---------- */
(function start() {
  const saved = lsGet(K_SCOPE), t = todayISO();
  scope = (saved && (saved === 'all' || dayOf(saved))) ? saved : (dayOf(t) ? t : 'all');
  renderMain();
  load();
  setInterval(() => { if (!document.hidden && !document.getElementById('bc-editor')) load(); }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
})();
})();
