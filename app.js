import * as E from './core/eta.mjs';

const $ = (s) => document.querySelector(s);
const pct = (x, d = 0) => (x * 100).toFixed(d) + '%';
const S = { day: 105, now: 10.75, shown: 17, pinned: null };
const METHOD_LABEL = { static: 'Route table p5-p95', gaussian: 'ETA ± 1.645σ', conformal: 'Split conformal', mondrian: 'Mondrian conformal', aci: 'Mondrian + ACI' };

async function boot() {
  const J = await (await fetch('data/trips.json')).json();
  const { net, hist } = E.fromJSON(J);
  const { rows } = E.buildRows(net, hist);
  const m = E.fitModels(rows);
  const C = E.calibrate(rows, m);
  const ev = E.evaluate(rows, m, C);
  const rel = E.lateReliability(rows, m, C);
  const pr = E.promises(rows, m, C);
  const fr = E.slackFrontier(rows, m);
  Object.assign(S, { J, net, hist, rows, m, C, ev, rel, pr, fr, testDays: ev.days });
  // per-day ACI state for the board: replay the online update up to the board day
  renderBoard(); renderAnalysis();
  $('#day-prev').onclick = () => { const i = S.testDays.indexOf(S.day); if (i > 0) { S.day = S.testDays[i - 1]; S.shown = 17; renderBoard(); } };
  $('#day-next').onclick = () => { const i = S.testDays.indexOf(S.day); if (i < S.testDays.length - 1) { S.day = S.testDays[i + 1]; S.shown = 17; renderBoard(); } };
  $('#board-time').oninput = (e) => { S.now = +e.target.value / 60; renderBoard(); };
  $('#load-more').onclick = () => { S.shown += 17; renderBoard(); };
}

// ACI alphas as they stood at the start of `day` (replays evaluate()'s daily update)
function aciAt(day) {
  const { rows, m, C } = S, a = {};
  for (const g of Object.keys(C.gqScores)) a[g] = C.alpha;
  for (const d of S.testDays) {
    if (d >= day) break;
    const err = {};
    for (const r of rows) if (r.day === d) { const [lo, hi] = E.interval('aci', r, m, C, a); (err[r.group] ||= [0, 0]); err[r.group][0] += (r.y < lo || r.y > hi) ? 1 : 0; err[r.group][1]++; }
    for (const [g, [e, n]] of Object.entries(err)) a[g] = Math.min(0.5, Math.max(0.001, a[g] + 0.005 * (n * C.alpha - e)));
  }
  return a;
}

function renderBoard() {
  const { rows, m, C } = S;
  if (S.aciDay !== S.day) { S.aci = aciAt(S.day); S.aciDay = S.day; }
  const snap = E.snapshot(rows, m, C, S.day, S.now, S.aci);
  S.snap = snap;
  const date = new Date(Date.UTC(2026, 6, 18) + S.day * 864e5);
  $('#board-date').textContent = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
  const active = snap.filter(t => t.state === 'Driving' || t.state === 'Unloading');
  const risk = active.filter(t => t.status === 'atRisk').length;
  $('#board-sub').textContent = `Board at ${E.fmtClock(S.now)} · ${active.length} trips active · ${risk} at risk${S.hist.weather[S.day] ? ' · rain' : ''}${S.day >= S.hist.shiftDay ? ' · I-30 lane closure' : ''}`;
  const head = `<div class="row head"><div class="c1">Truck</div><div class="c">Start Time</div><div class="c">End Time</div><div class="c2">Driving Time</div><div class="c">Stops</div><div class="c2 new-col">Arrival window (90%)</div><div class="c new-col">On-time</div><div class="c2">Status</div></div>`;
  // board window: trips that started in the last 2.5 hours or later, in start order (like the live board)
  const win = snap.filter(t => t.start >= S.now - 2.5 || t.state === 'Driving' || t.state === 'Unloading');
  const list = win.slice(0, S.shown);
  const body = list.map((t, i) => {
    const fade = i === list.length - 1 && win.length > S.shown ? ' faded2' : i === list.length - 2 && win.length > S.shown ? ' faded' : '';
    const dots = Array.from({ length: t.n }, (_, k) => `<i class="dot${t.state === 'Completed' || k < t.done ? ' done' : ''}"></i>`).join('');
    const endHr = t.state === 'Completed' ? t.endActual : t.etaMid + (t.trip.stops[t.n - 1].dwell / 60) * 0 ;
    const band = bandStr(t.etaLo, t.etaHi);
    const onT = t.state === 'Completed' ? `<span class="muted">${t.lateActual ? 'Late' : 'Met'}</span>` : `<span class="prob${t.pOnTime < 0.8 ? ' low' : ''}">${pct(t.pOnTime)}</span>`;
    const lab = { completed: 'Completed', onTime: 'On Time', ready: 'Ready', atRisk: 'At risk' }[t.status];
    return `<div class="row${fade}${S.pinned === t.id ? ' pinned' : ''}" data-i="${i}"><div class="c1">${t.id}</div><div class="c">${E.fmtClock(t.start)}</div><div class="c${t.state === 'Completed' ? '' : ' muted'}">${E.fmtClock(endHr)}</div><div class="c2">${hrs(t.driveMin)}</div><div class="c"><span class="dots">${dots}</span></div><div class="c2 band${t.state === 'Completed' ? ' past' : ''}">${band}</div><div class="c">${onT}</div><div class="c2 cell-status"><span>${t.state}</span><span class="label ${t.status}">${lab}</span></div></div>`;
  }).join('');
  $('#table').innerHTML = head + body;
  $('#load-more').style.display = win.length > S.shown ? '' : 'none';
  document.querySelectorAll('.row[data-i]').forEach(el => {
    el.onmouseenter = () => showTip(el, list[+el.dataset.i]);
    el.onmouseleave = () => { if (S.pinned !== list[+el.dataset.i].id) hideTip(); };
    el.onclick = () => { const id = list[+el.dataset.i].id; S.pinned = S.pinned === id ? null : id; renderBoard(); if (S.pinned) showTip(document.querySelector(`.row[data-i="${el.dataset.i}"]`), list[+el.dataset.i]); else hideTip(); };
  });
  if (S.pinned) { const i = list.findIndex(t => t.id === S.pinned); if (i >= 0) showTip(document.querySelector(`.row[data-i="${i}"]`), list[i]); }
}
const bandStr = (lo, hi) => { const a = E.fmtClock(lo), b = E.fmtClock(hi); return (a.slice(-2) === b.slice(-2) ? a.slice(0, -3) : a) + '–' + b; };
const hrs = (min) => `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, '0')} hrs`;

function showTip(el, t) {
  const tip = $('#tooltip'), r = el.getBoundingClientRect();
  // header: the trip's stops as a line with 90% arrival bands per stop
  const W = 240, H = 84, x0 = 20, x1 = W - 20;
  const tMin = t.start, tMax = Math.max(t.etaHi, t.deadline, ...t.stopBands.map(b => t.start + b.hi / 60)) + 0.05;
  const X = (h) => x0 + (h - tMin) / (tMax - tMin) * (x1 - x0);
  let s = `<line x1="${x0}" x2="${x1}" y1="58" y2="58" stroke="#19191a" stroke-width="1.5"/>`;
  s += `<circle cx="${x0}" cy="58" r="4" fill="#19191a"/>`;
  t.stopBands.forEach((b, k) => {
    const lo = X(t.start + b.lo / 60), hi = X(t.start + b.hi / 60), mid = X(t.start + b.mid / 60);
    s += `<rect x="${lo}" y="42" width="${Math.max(2, hi - lo)}" height="16" rx="8" fill="rgba(255,255,255,.55)"/>`;
    s += `<circle cx="${mid}" cy="50" r="4" fill="${b.arrived ? '#19191a' : '#fff'}" stroke="#19191a" stroke-width="1.5"/>`;
    if (b.arrived) s += `<line x1="${X(t.start + b.actual / 60)}" x2="${X(t.start + b.actual / 60)}" y1="38" y2="62" stroke="#5b11f5" stroke-width="2"/>`;
  });
  const dl = X(t.deadline);
  s += `<line x1="${dl}" x2="${dl}" y1="24" y2="66" stroke="#19191a" stroke-dasharray="2 2"/><text x="${dl}" y="18" text-anchor="middle" font-size="10" fill="#19191a">Due ${E.fmtClock(t.deadline)}</text>`;
  s += `<text x="${x0}" y="78" font-size="10" fill="#19191a">${E.fmtClock(t.start)}</text><text x="${x1}" y="78" text-anchor="end" font-size="10" fill="#19191a">${E.fmtClock(tMax)}</text>`;
  $('#tt-header').innerHTML = `<svg viewBox="0 0 ${W} ${H}">${s}</svg>`;
  const next = t.stopBands.find(b => !b.arrived);
  const finalBand = bandStr(t.etaLo, t.etaHi);
  const covered = t.state === 'Completed' ? (t.stopBands.every(b => b.actual >= b.lo && b.actual <= b.hi) ? 'All stops inside band' : `${t.stopBands.filter(b => b.actual < b.lo || b.actual > b.hi).length} stop(s) outside band`) : null;
  const items = [
    ['Stops today', `${t.state === 'Completed' ? t.n : t.done}/${t.n}`],
    ['Next stop', next ? next.store : '-'],
    ['Final ETA (90%)', finalBand],
    [t.state === 'Completed' ? 'Outcome' : 'On-time probability', t.state === 'Completed' ? (t.lateActual ? 'Late' : 'On time') : pct(t.pOnTime)],
    ['Driving duration', `${(t.driveMin / 60).toFixed(1)} hrs`],
    ['Refrigerated', t.refrigerated ? 'Yes' : 'No'],
  ];
  $('#tt-body').innerHTML = items.map(([a, b]) => `<li><span>${a}</span><span>${b}</span></li>`).join('') + (covered ? `<li class="wide"><span>Band check</span><span>${covered}</span></li>` : '');
  // anchored on the Stops column like the production hover card
  const colX = document.querySelectorAll('.row.head > div')[4].getBoundingClientRect().left;
  tip.style.left = Math.min(colX - 34, innerWidth - 260) + 'px';
  tip.style.top = (r.top + r.height / 2) + 'px';
  tip.classList.add('on');
}
function hideTip() { $('#tooltip').classList.remove('on'); }

// ---------------- analysis (newsroom-style list) ----------------
function renderAnalysis() {
  const { ev, rel, pr, fr, C } = S, st = ev.stats;
  const pre = (k) => { const d = st[k].byDay.filter(x => x.day < S.hist.shiftDay); return d.reduce((a, x) => a + x.cover, 0) / d.length; };
  const post = (k) => { const d = st[k].byDay.filter(x => x.day >= S.hist.shiftDay); return d.reduce((a, x) => a + x.cover, 0) / d.length; };
  const gk = ['dry|first', 'dry|later', 'rain|first', 'rain|later'];
  const gName = { 'dry|first': 'Dry, first stop', 'dry|later': 'Dry, later stops', 'rain|first': 'Rain, first stop', 'rain|later': 'Rain, later stops' };
  const spread = (k) => { const v = gk.map(g => st[k].byGroup[g].cover / st[k].byGroup[g].n); return [Math.min(...v), Math.max(...v)]; };
  const f99 = (k) => fr[k].find(x => x.target === 0.99).slack;
  const items = [
    { date: 'Coverage', sub: `${ev.days.length} held-out days · ${st.aci.n.toLocaleString()} stop arrivals`, title: `Bands that stay near 90% in every condition, and ${Math.round(st.gaussian.meanWidth - st.mondrian.meanWidth)} minutes narrower`,
      text: `Target: 90% of actual arrivals inside the window. A single ±σ band covers <b>${pct(spread('gaussian')[0])}-${pct(spread('gaussian')[1])}</b> across conditions (too wide on short dry legs, too narrow on rainy multi-stop runs) at <b>${st.gaussian.meanWidth.toFixed(0)} min</b> wide. Normalised conformal bands scale with each trip's learned uncertainty: <b>${st.mondrian.meanWidth.toFixed(0)} min</b> wide and ${pct(spread('aci')[0])}-${pct(spread('aci')[1])} with the ACI update. The dispatcher's route table is <b>${st.static.meanWidth.toFixed(0)} min</b> wide.`, chart: coverageChart(gk, gName) },
    { date: 'Drift', sub: `I-30 lane closure from ${new Date(Date.UTC(2026, 6, 18) + S.hist.shiftDay * 864e5).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`, title: 'Adaptive conformal inference re-widens bands when the road changes',
      text: `Calibration ends before the closure. Afterwards, split conformal falls from <b>${pct(pre('conformal'))}</b> to <b>${pct(post('conformal'))}</b> coverage; the ACI loop, which nudges each group's miscoverage level after every day of outcomes, holds <b>${pct(post('aci'))}</b> without retraining the ETA model.`, chart: driftChart() },
    { date: 'Late risk', sub: `${rel.n.toLocaleString()} test arrivals, deadline = ETA + 12 min`, title: 'On-time probabilities you can act on',
      text: `The on-time column is a conformal predictive probability. Brier score <b>${rel.brier.toFixed(3)}</b> vs <b>${rel.brierGaussian.toFixed(3)}</b> for a Gaussian on the same point ETA; the Gaussian never says anything other than ${pct(Math.min(...rel.gauss.filter(b => b.n).map(b => b.p / b.n)))}-${pct(Math.max(...rel.gauss.filter(b => b.n).map(b => b.p / b.n)))}.`, chart: reliabilityChart() },
    { date: 'Promises', sub: `${pr.n.toLocaleString()} test trips, final stop`, title: `${(f99('mins') - f99('conformal')).toFixed(0)} fewer minutes of padding per trip at 99% on-time`,
      text: `Promising an arrival time means adding slack to the ETA. A flat-minute buffer needs <b>${f99('mins').toFixed(0)} min</b> on average to reach 99% on time on these trips, a percentage buffer <b>${f99('pct').toFixed(0)} min</b>, a buffer proportional to the learned scale <b>${f99('conformal').toFixed(0)} min</b>. Tuned only on calibration days (no peeking), the conformal promise lands at <b>${pct(pr.conformal.ontime, 1)}</b> on time with ${pr.conformal.slack.toFixed(0)} min slack vs ${pct(pr.mins.ontime, 1)} and ${pr.mins.slack.toFixed(0)} min for flat minutes.`, chart: frontierChart() },
    { date: 'Method', sub: 'Synthetic network · seeded', title: 'How the numbers are made',
      text: `120 days of synthetic DFW trips (2 DCs, 36 stores, 44 trips/day, 1-5 stops) from a simulator with AV-style left-turn and signal delays, school zones, rush hours, rain, store-specific dock dwell and rare remote-assist pauses. Days 0-69 fit a linear ETA model and a linear scale model; days 70-95 calibrate (${C.nCal.toLocaleString()} stop arrivals); days 96-119 are held out. In-trip updates on the board shift the band by the delay seen at the last stop, which is a heuristic outside the guarantee.`, chart: '' },
  ];
  $('#analysis').innerHTML = items.map(it => `<article class="news-item"><div class="news-date">${it.date}<small>${it.sub}</small></div><div class="news-body"><h3>${it.title}</h3><p>${it.text}</p>${it.chart ? `<div class="chart">${it.chart}</div>` : ''}</div><svg class="news-arrow" viewBox="0 0 12 12"><path d="M2 6h8M6.5 2.5 10 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.1"/></svg></article>`).join('');
}

function axis(W, H, L, B, ylo, yhi, fmtY, ticks = 4) {
  let s = '';
  for (let k = 0; k <= ticks; k++) { const v = ylo + (yhi - ylo) * k / ticks, y = H - B - (v - ylo) / (yhi - ylo) * (H - B - 8); s += `<line x1="${L}" x2="${W}" y1="${y}" y2="${y}" stroke="#e8eaec"/><text x="${L - 6}" y="${y + 3}" text-anchor="end">${fmtY(v)}</text>`; }
  return s;
}
function coverageChart(gk, gName) {
  const st = S.ev.stats, ms = ['static', 'gaussian', 'mondrian', 'aci'], W = 520, H = 170, L = 34, B = 22;
  const colors = { static: '#d7d8d9', gaussian: '#b2b2b3', mondrian: '#19191a', aci: '#5b11f5' };
  const lo = 0.6, hi = 1.0, y = v => H - B - (v - lo) / (hi - lo) * (H - B - 8);
  let s = axis(W, H, L, B, lo, hi, v => pct(v));
  const gw = (W - L) / gk.length, bw = (gw - 18) / ms.length;
  gk.forEach((g, gi) => {
    ms.forEach((k, mi) => { const v = st[k].byGroup[g].cover / st[k].byGroup[g].n, x = L + gi * gw + 9 + mi * bw; s += `<rect x="${x}" y="${y(v)}" width="${bw - 3}" height="${H - B - y(v)}" rx="1.5" fill="${colors[k]}"/>`; });
    s += `<text x="${L + gi * gw + gw / 2}" y="${H - 6}" text-anchor="middle">${gName[g]}</text>`;
  });
  s += `<line x1="${L}" x2="${W}" y1="${y(0.9)}" y2="${y(0.9)}" stroke="#f63737" stroke-dasharray="3 3"/><text x="${W}" y="${y(0.9) - 4}" text-anchor="end" style="fill:#f63737">90% target</text>`;
  return `<svg viewBox="0 0 ${W} ${H}">${s}</svg><div class="legend">${ms.map(k => `<span><i class="sq" style="background:${colors[k]}"></i>${METHOD_LABEL[k]} · ${S.ev.stats[k].meanWidth.toFixed(0)} min</span>`).join('')}</div>`;
}
function driftChart() {
  const st = S.ev.stats, W = 520, H = 150, L = 34, B = 22, days = S.ev.days, lo = 0.6, hi = 1.0;
  const x = d => L + (d - days[0]) / (days[days.length - 1] - days[0]) * (W - L - 6), y = v => H - B - (v - lo) / (hi - lo) * (H - B - 8);
  let s = axis(W, H, L, B, lo, hi, v => pct(v));
  const sx = x(S.hist.shiftDay - 0.5);
  s += `<rect x="${sx}" y="8" width="${W - 6 - sx}" height="${H - B - 8}" fill="#f5f6f8"/><text x="${sx + 6}" y="20">Lane closure</text>`;
  s += `<line x1="${L}" x2="${W}" y1="${y(0.9)}" y2="${y(0.9)}" stroke="#f63737" stroke-dasharray="3 3"/>`;
  const line = (k, c, w, dash = '') => `<path d="${st[k].byDay.map((p, i) => (i ? 'L' : 'M') + x(p.day).toFixed(1) + ' ' + y(Math.max(lo, p.cover)).toFixed(1)).join('')}" fill="none" stroke="${c}" stroke-width="${w}" stroke-dasharray="${dash}"/>`;
  s += line('static', '#b2b2b3', 1.2, '3 3') + line('conformal', '#19191a', 1.4) + line('aci', '#5b11f5', 2);
  days.forEach((d, i) => { if (i % 4 === 0) s += `<text x="${x(d)}" y="${H - 6}" text-anchor="middle">Day ${d}</text>`; });
  return `<svg viewBox="0 0 ${W} ${H}">${s}</svg><div class="legend"><span><i class="dash" style="border-color:#b2b2b3"></i>Route table</span><span><i style="border-color:#19191a"></i>Split conformal</span><span><i style="border-color:#5b11f5"></i>Mondrian + ACI</span></div>`;
}
function reliabilityChart() {
  const { rel } = S, W = 520, H = 170, L = 34, B = 22, lo = 0, hi = 0.4;
  const x = v => L + v / hi * (W - L - 6), y = v => H - B - v / hi * (H - B - 8);
  let s = axis(W, H, L, B, lo, hi, v => pct(v));
  for (let k = 0; k <= 4; k++) s += `<text x="${x(k * 0.1)}" y="${H - 6}" text-anchor="middle">${pct(k * 0.1)}</text>`;
  s += `<line x1="${x(0)}" y1="${y(0)}" x2="${x(hi)}" y2="${y(hi)}" stroke="#b2b2b3" stroke-dasharray="3 3"/>`;
  const pts = (bins, c, r) => bins.filter(b => b.n >= 15).map(b => `<circle cx="${x(Math.min(hi, b.p / b.n))}" cy="${y(Math.min(hi, b.o / b.n))}" r="${Math.min(9, 2.5 + Math.sqrt(b.n) / 6)}" fill="${c}" fill-opacity=".85"/>`).join('');
  s += pts(rel.gauss, '#b2b2b3') + pts(rel.bins, '#5b11f5');
  s += `<text x="${W - 6}" y="${H - B - 6}" text-anchor="end">Predicted P(late) → observed late rate</text>`;
  return `<svg viewBox="0 0 ${W} ${H}">${s}</svg><div class="legend"><span><i class="sq" style="background:#5b11f5"></i>Conformal predictive</span><span><i class="sq" style="background:#b2b2b3"></i>Gaussian</span><span>Dot size = trips in bin</span></div>`;
}
function frontierChart() {
  const { fr, pr } = S, W = 520, H = 170, L = 34, B = 22;
  const all = Object.values(fr).flat(), T = fr.mins.map(p => p.target), ylo = 0, yhi = Math.ceil(Math.max(...all.map(p => p.slack)) / 10) * 10;
  const x = v => L + 14 + T.indexOf(v) / (T.length - 1) * (W - L - 34), y = v => H - B - (v - ylo) / (yhi - ylo) * (H - B - 8);
  let s = axis(W, H, L, B, ylo, yhi, v => v.toFixed(0) + 'm');
  T.forEach(t => s += `<text x="${x(t)}" y="${H - 6}" text-anchor="middle">${pct(t, t === 0.995 ? 1 : 0)} on time</text>`);
  const c = { mins: '#b2b2b3', pct: '#19191a', conformal: '#5b11f5' };
  for (const [k, v] of Object.entries(fr)) s += `<path d="${v.map((p, i) => (i ? 'L' : 'M') + x(p.target).toFixed(1) + ' ' + y(p.slack).toFixed(1)).join('')}" fill="none" stroke="${c[k]}" stroke-width="${k === 'conformal' ? 2 : 1.3}"/>` + v.map(p => `<circle cx="${x(p.target)}" cy="${y(p.slack)}" r="2.5" fill="${c[k]}"/>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}">${s}</svg><div class="legend"><span><i style="border-color:#b2b2b3"></i>Flat minutes</span><span><i style="border-color:#19191a"></i>Percent of ETA</span><span><i style="border-color:#5b11f5"></i>Conformal scale</span><span>x: on-time rate · y: average slack</span></div>`;
}

boot().catch(e => { console.error(e); $('#board-sub').textContent = 'Error: ' + e.message; });
