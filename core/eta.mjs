// On-time confidence for driverless middle-mile trips.
// Synthetic DC -> store network, a travel/dwell simulator with heteroscedastic, heavy-tailed
// noise and a mid-period regime shift, and five ways to put an interval around a stop ETA:
//   static     : per-route empirical p05/p95 of historical durations (what a dispatcher table does)
//   gaussian   : linear ETA model +/- z * global residual sd
//   conformal  : linear ETA + linear scale model, split-conformal on normalised residuals
//   mondrian   : the same, calibrated separately per condition group (weather x stop position)
//   aci        : mondrian + adaptive conformal inference (Gibbs & Candes 2021) updated daily
// plus conformal late-risk probabilities and 99%-on-time dispatch promises.
// Pure functions; runs in Node (tests, data script) and the browser.

export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function normal(R) { let u = 0, v = 0; while (u === 0) u = R(); v = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const hav = (a, b) => { const R = 3958.8, toR = Math.PI / 180; const dLa = (b[0] - a[0]) * toR, dLo = (b[1] - a[1]) * toR; const s = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };

// ---------------- network + simulator ----------------
export function buildNetwork(seed = 7) {
  const R = rng(seed);
  const dcs = [{ id: 'DC-1', name: 'Dallas DC', ll: [32.7357, -96.8681] }, { id: 'DC-2', name: 'Fort Worth DC', ll: [32.7826, -97.2433] }];
  const stores = [];
  for (let i = 0; i < 36; i++) {
    const dc = dcs[i % 2];
    const r = 2 + 13 * Math.sqrt(R()), th = 2 * Math.PI * R();
    stores.push({ id: `S${String(i + 1).padStart(2, '0')}`, dc: dc.id, ll: [dc.ll[0] + r / 69 * Math.sin(th), dc.ll[1] + r / 58 * Math.cos(th)],
      dwellMean: 11 + 14 * R(), dwellSpread: 0.25 + 0.35 * R(), // lognormal sigma of dock dwell
      corridor: R() < 0.12 }); // legs to/from these stores cross the I-30 corridor (construction later)
  }
  return { dcs, stores };
}

const legKey = (a, b) => `${a}>${b}`;
export function legFeatures(net, fromId, toId, cache = new Map()) {
  const k = legKey(fromId, toId);
  if (cache.has(k)) return cache.get(k);
  const all = [...net.dcs, ...net.stores];
  const A = all.find(x => x.id === fromId), B = all.find(x => x.id === toId);
  // deterministic per-leg road attributes from a hash of the pair
  let h = 2166136261; for (const c of k) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  const R = rng(h >>> 0);
  const crow = hav(A.ll, B.ll), miles = crow * (1.22 + 0.12 * R());
  const hwy = Math.min(0.85, Math.max(0, (miles - 2) / 14 + 0.15 * (R() - 0.5)));
  const f = { miles, hwy, lefts: Math.round(1 + miles * (1 - hwy) * 0.35 * R() + R() * 2), signals: Math.round(2 + miles * (1 - hwy) * 1.1 * (0.5 + R())),
    school: R() < 0.3 ? 1 : 0, corridor: (A.corridor || B.corridor) ? 1 : 0 };
  cache.set(k, f);
  return f;
}

const trafficMult = (hr) => 1 + 0.32 * Math.exp(-((hr - 7.8) ** 2) / 1.1) + 0.38 * Math.exp(-((hr - 17.2) ** 2) / 1.4) + 0.12 * Math.exp(-((hr - 12.3) ** 2) / 2);
const schoolActive = (hr) => (hr >= 7 && hr < 8.75) || (hr >= 14.5 && hr < 16);

// true (simulated) leg drive time and dock dwell, minutes
export function simulateLeg(f, hr, wx, day, R, shiftDay) {
  const speed = 24 + 33 * f.hwy;                       // mph, AV-limited box truck
  let drive = f.miles / speed * 60 * trafficMult(hr) * (wx ? 1.12 + 0.06 * R() : 1);
  drive += f.lefts * (0.35 + 0.9 * R() * R());         // conservative unprotected lefts
  drive += f.signals * 0.45 * R();                       // signal waits
  if (f.school && schoolActive(hr)) drive += f.miles * 0.8 * (1 - f.hwy) + 1.5;
  drive *= Math.exp(0.07 * normal(R) * (wx ? 1.7 : 1)); // multiplicative noise, wider in rain
  if (R() < (wx ? 0.035 : 0.012)) drive += 3 + Math.exp(1.2 + 0.8 * normal(R)); // remote-assist / MRC pause
  if (f.corridor && day >= shiftDay) drive += 3 + 5 * R() + (hr > 6 && hr < 19 ? 2.5 * trafficMult(hr) : 0); // lane closure on the I-30 corridor
  return drive;
}
export function simulateDwell(store, hr, R) {
  const rush = 1 + 0.45 * Math.exp(-((hr - 9.5) ** 2) / 3); // morning receiving peak
  return store.dwellMean * rush * Math.exp(store.dwellSpread * normal(R) - store.dwellSpread ** 2 / 2);
}

// Generate `days` of trips. Each trip: DC -> k stores. Returns flat stop records.
export function generateHistory(net, { days = 120, seed = 20261110, shiftDay = 106, tripsPerDay = 44 } = {}) {
  const R = rng(seed), cache = new Map();
  const trips = [];
  const weather = [];
  for (let d = 0; d < days; d++) {
    const wx = R() < (d % 30 < 10 ? 0.28 : 0.14) ? 1 : 0; // clustered rain days
    weather.push(wx);
    for (let t = 0; t < tripsPerDay; t++) {
      const dc = net.dcs[t % 2];
      const pool = net.stores.filter(s => s.dc === dc.id);
      const k = 1 + Math.floor(R() * R() * 5) + (R() < 0.3 ? 1 : 0);
      const seq = []; while (seq.length < Math.min(k, 5)) { const s = pool[Math.floor(R() * pool.length)]; if (!seq.includes(s)) seq.push(s); }
      const start = 4.5 + 15 * R(); // hour of day
      let clock = start, prev = dc.id;
      const stops = [];
      for (let i = 0; i < seq.length; i++) {
        const f = legFeatures(net, prev, seq[i].id, cache);
        const drive = simulateLeg(f, clock, wx, d, R, shiftDay);
        clock += drive / 60;
        const arrive = clock;
        const dwell = simulateDwell(seq[i], clock, R);
        clock += dwell / 60;
        stops.push({ store: seq[i].id, from: prev, idx: i, arriveHr: arrive, drive, dwell });
        prev = seq[i].id;
      }
      trips.push({ day: d, id: `G-${String(t + 1).padStart(3, '0')}A`, dc: dc.id, start, wx, refrigerated: R() < 0.35, stops });
    }
  }
  return { trips, weather, shiftDay };
}

// ---------------- features + models ----------------
// Features known at dispatch for the cumulative arrival time at stop j (minutes after start)
export function stopFeatures(net, trip, j, cache, dwellMeans, dwellSds = {}) {
  let miles = 0, hwyMiles = 0, lefts = 0, signals = 0, school = 0, corridor = 0, dwellPrior = 0, dwellVar = 0;
  let hr = trip.start;
  for (let i = 0; i <= j; i++) {
    const st = trip.stops[i];
    const f = legFeatures(net, st.from, st.store, cache);
    miles += f.miles; hwyMiles += f.miles * f.hwy; lefts += f.lefts; signals += f.signals;
    if (f.school && schoolActive(hr)) school += f.miles * (1 - f.hwy);
    corridor += f.corridor;
    if (i < j) { dwellPrior += dwellMeans[st.store]; dwellVar += (dwellSds[st.store] || 0) ** 2; }
  }
  const peak = trafficMult(trip.start + 0.5) - 1;
  return [1, miles, hwyMiles, lefts, signals, school, peak * miles, trip.wx * miles, trip.wx, dwellPrior, j, corridor, Math.sqrt(dwellVar)];
}
export const FEATURE_NAMES = ['intercept', 'miles', 'highway miles', 'unprotected lefts', 'signals', 'school-zone miles', 'peak x miles', 'rain x miles', 'rain', 'prior dwell', 'stop index', 'corridor legs', 'prior dwell sd'];

// cumulative arrival minutes at each stop (target)
export const cumArrival = (trip, j) => (trip.stops[j].arriveHr - trip.start) * 60;

export function ols(X, y, ridge = 1e-6) {
  const p = X[0].length, A = Array.from({ length: p }, () => new Float64Array(p)), b = new Float64Array(p);
  for (let i = 0; i < X.length; i++) { const x = X[i]; for (let a = 0; a < p; a++) { b[a] += x[a] * y[i]; for (let c = 0; c < p; c++) A[a][c] += x[a] * x[c]; } }
  for (let a = 0; a < p; a++) A[a][a] += ridge * X.length;
  // Gaussian elimination with partial pivoting
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < p; c++) {
    let piv = c; for (let r = c + 1; r < p; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < p; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= p; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[p] / r[i]);
}
export const dot = (w, x) => { let s = 0; for (let i = 0; i < w.length; i++) s += w[i] * x[i]; return s; };

// conformal quantile with finite-sample correction: ceil((n+1)(1-a))/n empirical quantile
export function conformalQuantile(scores, alpha) {
  const s = Float64Array.from(scores).sort();
  const n = s.length, k = Math.ceil((n + 1) * (1 - alpha));
  if (k > n) return Infinity;
  return s[Math.max(0, k - 1)];
}

// Build the dataset of (trip, stop) rows with features, split by day
export function buildRows(net, hist, cache = new Map()) {
  // dwell means from the training window only (days < 70) to avoid leakage
  const sum = {}, cnt = {}, sq = {};
  for (const t of hist.trips) if (t.day < 70) for (const s of t.stops) { sum[s.store] = (sum[s.store] || 0) + s.dwell; sq[s.store] = (sq[s.store] || 0) + s.dwell * s.dwell; cnt[s.store] = (cnt[s.store] || 0) + 1; }
  const dwellMeans = {}, dwellSds = {};
  for (const s of net.stores) { const n = cnt[s.id] || 0; dwellMeans[s.id] = n ? sum[s.id] / n : 18; dwellSds[s.id] = n > 1 ? Math.sqrt(Math.max(0, sq[s.id] / n - dwellMeans[s.id] ** 2)) : 6; }
  const rows = [];
  for (const t of hist.trips) for (let j = 0; j < t.stops.length; j++) {
    rows.push({ trip: t, j, day: t.day, x: stopFeatures(net, t, j, cache, dwellMeans, dwellSds), y: cumArrival(t, j), group: `${t.wx ? 'rain' : 'dry'}|${j === 0 ? 'first' : 'later'}`, route: `${t.dc}>${t.stops.slice(0, j + 1).map(s => s.store).join('>')}` });
  }
  return { rows, dwellMeans, dwellSds };
}

export function fitModels(rows, { trainEnd = 70 } = {}) {
  const tr = rows.filter(r => r.day < trainEnd);
  const w = ols(tr.map(r => r.x), tr.map(r => r.y), 1e-4);
  // scale model: regress |residual| on the same features (clipped positive)
  const res = tr.map(r => Math.abs(r.y - dot(w, r.x)));
  const v = ols(tr.map(r => r.x), res, 1e-4);
  const sd = Math.sqrt(tr.reduce((a, r) => a + (r.y - dot(w, r.x)) ** 2, 0) / tr.length);
  // static route table: empirical quantiles of y per route-prefix key (fallback: per stop index)
  const byRoute = new Map(), byIdx = new Map();
  for (const r of tr) {
    if (!byRoute.has(r.route)) byRoute.set(r.route, []); byRoute.get(r.route).push(r.y);
    if (!byIdx.has(r.j)) byIdx.set(r.j, []); byIdx.get(r.j).push(r.y - r.x[1] * 2.6);
  }
  return { w, v, sd, byRoute, byIdx };
}
export const predict = (m, x) => dot(m.w, x);
export const scale = (m, x) => Math.max(1.5, dot(m.v, x));

// Calibrate on days [trainEnd, calEnd). Returns per-method calibration state.
export function calibrate(rows, m, { trainEnd = 70, calEnd = 96, alpha = 0.1, alphaLate = 0.01 } = {}) {
  const cal = rows.filter(r => r.day >= trainEnd && r.day < calEnd);
  const score2 = r => Math.abs(r.y - predict(m, r.x)) / scale(m, r.x);     // two-sided normalised
  const scoreUp = r => (r.y - predict(m, r.x)) / scale(m, r.x);            // one-sided (lateness)
  const q = conformalQuantile(cal.map(score2), alpha);
  const qUp = conformalQuantile(cal.map(scoreUp), alphaLate);
  const groups = {};
  for (const r of cal) { (groups[r.group] ||= { s2: [], up: [] }); groups[r.group].s2.push(score2(r)); groups[r.group].up.push(scoreUp(r)); }
  const gq = {}; for (const [g, v] of Object.entries(groups)) gq[g] = { q: conformalQuantile(v.s2, alpha), qUp: conformalQuantile(v.up, alphaLate), n: v.s2.length, up: Float64Array.from(v.up).sort() };
  const calUp = Float64Array.from(cal.map(scoreUp)).sort();
  const z = 1.6449; // two-sided 90% normal
  return { q, qUp, gq, calUp, alpha, alphaLate, z, nCal: cal.length };
}

// Interval for a row under each method; aci uses a supplied alpha_t per group
export function interval(method, r, m, C, aciAlpha) {
  const yhat = predict(m, r.x), s = scale(m, r.x);
  if (method === 'gaussian') return [yhat - C.z * m.sd, yhat + C.z * m.sd];
  if (method === 'static') {
    const arr = m.byRoute.get(r.route);
    if (arr && arr.length >= 8) { const a = Float64Array.from(arr).sort(); return [a[Math.floor(0.05 * (a.length - 1))], a[Math.ceil(0.95 * (a.length - 1))]]; }
    const base = r.x[1] * 2.6, a = Float64Array.from(m.byIdx.get(Math.min(r.j, 4)) || [0]).sort();
    return [base + a[Math.floor(0.05 * (a.length - 1))], base + a[Math.ceil(0.95 * (a.length - 1))]];
  }
  if (method === 'conformal') return [yhat - C.q * s, yhat + C.q * s];
  const g = C.gq[r.group] || { q: C.q };
  if (method === 'mondrian') return [yhat - g.q * s, yhat + g.q * s];
  if (method === 'aci') {
    const a = aciAlpha?.[r.group] ?? C.alpha;
    const v = C.gqScores?.[r.group];
    let qq = v ? (a >= 1 ? 0 : conformalQuantile(v, a)) : g.q;
    if (!isFinite(qq)) qq = Math.max(...v); // alpha_t below 1/(n+1): use the largest calibration score
    return [yhat - qq * s, yhat + qq * s];
  }
  throw new Error('unknown method ' + method);
}

// Late-risk: conformal predictive p-value that arrival exceeds a deadline (minutes after start)
export function lateProbability(r, m, C, deadline) {
  const s = (deadline - predict(m, r.x)) / scale(m, r.x);
  const g = C.gq[r.group];
  const arr = g && g.n >= 50 ? g.up : C.calUp;
  // fraction of calibration scores strictly greater than s, with the +1 smoothing
  let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= s) lo = mid + 1; else hi = mid; }
  return (arr.length - lo + 1) / (arr.length + 1);
}

// Evaluate all methods on test days with an online ACI loop (daily updates, per group)
export function evaluate(rows, m, C, { testStart = 96, gamma = 0.005 } = {}) {
  const methods = ['static', 'gaussian', 'conformal', 'mondrian', 'aci'];
  const test = rows.filter(r => r.day >= testStart);
  // ACI needs per-group calibration score arrays
  const cal = rows.filter(r => r.day >= 70 && r.day < testStart);
  C.gqScores = {};
  for (const r of cal) { (C.gqScores[r.group] ||= []).push(Math.abs(r.y - predict(m, r.x)) / scale(m, r.x)); }
  const aciA = {}; for (const g of Object.keys(C.gqScores)) aciA[g] = C.alpha;
  const days = [...new Set(test.map(r => r.day))].sort((a, b) => a - b);
  const stats = Object.fromEntries(methods.map(k => [k, { n: 0, cover: 0, width: 0, byGroup: {}, byDay: [], corridor: { n: 0, cover: 0 } }]));
  for (const d of days) {
    const rd = test.filter(r => r.day === d);
    const errByGroup = {};
    for (const k of methods) {
      let n = 0, c = 0;
      for (const r of rd) {
        const [lo, hi] = interval(k, r, m, C, aciA);
        const ok = r.y >= lo && r.y <= hi;
        const S = stats[k]; S.n++; S.cover += ok; S.width += hi - lo; n++; c += ok;
        (S.byGroup[r.group] ||= { n: 0, cover: 0 }); S.byGroup[r.group].n++; S.byGroup[r.group].cover += ok;
        if (r.x[11] > 0) { S.corridor.n++; S.corridor.cover += ok; }
        if (k === 'aci') { (errByGroup[r.group] ||= [0, 0]); errByGroup[r.group][0] += ok ? 0 : 1; errByGroup[r.group][1]++; }
      }
      stats[k].byDay.push({ day: d, cover: c / n });
    }
    // ACI update after the day's outcomes are observed: alpha <- alpha + gamma * sum_i (alpha* - err_i)
    for (const [g, [e, n]] of Object.entries(errByGroup)) aciA[g] = Math.min(0.5, Math.max(0.001, aciA[g] + gamma * (n * C.alpha - e)));
  }
  for (const k of methods) { const S = stats[k]; S.coverage = S.cover / S.n; S.meanWidth = S.width / S.n; }
  return { stats, days, aciAlpha: aciA };
}

// Reliability of late-risk probabilities: bucket predicted P(late) vs observed, for a promise
// set at the planner's nominal duration (deadline = point ETA + slack)
export function lateReliability(rows, m, C, { testStart = 96, slackMin = 12 } = {}) {
  const test = rows.filter(r => r.day >= testStart);
  const bins = Array.from({ length: 10 }, () => ({ p: 0, o: 0, n: 0 }));
  const gauss = Array.from({ length: 10 }, () => ({ p: 0, o: 0, n: 0 }));
  let brier = 0, brierG = 0;
  const Phi = z => 0.5 * (1 + erf(z / Math.SQRT2));
  for (const r of test) {
    const deadline = predict(m, r.x) + slackMin;
    const p = lateProbability(r, m, C, deadline), late = r.y > deadline ? 1 : 0;
    const pg = 1 - Phi((deadline - predict(m, r.x)) / m.sd);
    const b = Math.min(9, Math.floor(p * 10)), bg = Math.min(9, Math.floor(pg * 10));
    bins[b].p += p; bins[b].o += late; bins[b].n++;
    gauss[bg].p += pg; gauss[bg].o += late; gauss[bg].n++;
    brier += (p - late) ** 2; brierG += (pg - late) ** 2;
  }
  return { bins, gauss, brier: brier / test.length, brierGaussian: brierG / test.length, n: test.length };
}
export function erf(x) { // Abramowitz-Stegun 7.1.26
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496735) * t + 0.254829592) * t * Math.exp(-x * x));
}

// Dispatch promises: arrival promise for the final stop of each test trip.
// conformal: point ETA + qUp(group) * scale  (target 99% on-time)
// fixed: point ETA * (1 + b), with b tuned on calibration days to hit 99% on-time
export function promises(rows, m, C, { trainEnd = 70, testStart = 96, target = 0.99 } = {}) {
  const last = rows.filter(r => r.j === r.trip.stops.length - 1);
  const cal = last.filter(r => r.day >= trainEnd && r.day < testStart), test = last.filter(r => r.day >= testStart);
  // fixed % buffer tuned on calibration
  const ratios = cal.map(r => r.y / predict(m, r.x) - 1);
  const bFix = conformalQuantile(ratios, 1 - target);
  // fixed minutes buffer tuned on calibration
  const mins = cal.map(r => r.y - predict(m, r.x));
  const mFix = conformalQuantile(mins, 1 - target);
  // conformal one-sided quantile from final-stop calibration rows, per weather group
  // (pooled across weather: the scale model already widens rain trips; a 99% quantile needs n >= 99 per group)
  const qUpAll = conformalQuantile(cal.map(r => (r.y - predict(m, r.x)) / scale(m, r.x)), 1 - target);
  const qUpW = { 0: qUpAll, 1: qUpAll };
  const out = { conformal: { slack: 0, ontime: 0 }, pct: { slack: 0, ontime: 0 }, mins: { slack: 0, ontime: 0 }, n: test.length, bFix, mFix, qUpW, nCal: cal.length };
  for (const r of test) {
    const yhat = predict(m, r.x);
    const qUp = qUpW[r.trip.wx];
    const pc = yhat + qUp * scale(m, r.x), pp = yhat * (1 + bFix), pm = yhat + mFix;
    out.conformal.slack += pc - yhat; out.conformal.ontime += r.y <= pc;
    out.pct.slack += pp - yhat; out.pct.ontime += r.y <= pp;
    out.mins.slack += pm - yhat; out.mins.ontime += r.y <= pm;
  }
  for (const k of ['conformal', 'pct', 'mins']) { out[k].slack /= test.length; out[k].ontime /= test.length; }
  return out;
}

// Efficiency frontier on test trips: average slack (minutes over the point ETA) each promise
// family needs to reach a given on-time rate. Families differ only in the shape of the buffer:
// minutes (constant), percent (proportional to ETA), conformal (proportional to the learned scale).
export function slackFrontier(rows, m, { testStart = 96, targets = [0.9, 0.95, 0.97, 0.98, 0.99, 0.995] } = {}) {
  const test = rows.filter(r => r.day >= testStart && r.j === r.trip.stops.length - 1);
  const fam = {
    mins: r => [r.y - predict(m, r.x), 1],
    pct: r => [(r.y - predict(m, r.x)) / predict(m, r.x), predict(m, r.x)],
    conformal: r => [(r.y - predict(m, r.x)) / scale(m, r.x), scale(m, r.x)],
  };
  const out = {};
  for (const [k, f] of Object.entries(fam)) {
    const sv = test.map(f), scores = Float64Array.from(sv.map(v => v[0])).sort();
    out[k] = targets.map(t => {
      const q = scores[Math.min(scores.length - 1, Math.ceil(t * scores.length) - 1)];
      const slack = sv.reduce((a, v) => a + Math.max(0, q * v[1]), 0) / sv.length;
      const on = sv.filter(v => v[0] <= q).length / sv.length;
      return { target: t, slack, ontime: on };
    });
  }
  return out;
}

// ---------------- live board snapshot ----------------
const fmtClock = (hr) => { const h = Math.floor(hr), mi = Math.round((hr - h) * 60); const H = (h + (mi === 60 ? 1 : 0)), M = mi === 60 ? 0 : mi; const ap = H >= 12 ? 'PM' : 'AM'; const h12 = ((H + 11) % 12) + 1; return `${h12}:${String(M).padStart(2, '0')} ${ap}`; };
export { fmtClock };

// Planned (appointment) duration a dispatcher would promise from the route table: median of the
// route's history + 10 min, falling back to 2.6 min/mile + prior dwell + 10
export function appointment(m, r) {
  const arr = m.byRoute.get(r.route);
  if (arr && arr.length >= 5) { const a = Float64Array.from(arr).sort(); return a[Math.floor(a.length / 2)] + 10; }
  return r.x[1] * 2.6 + r.x[9] + 10;
}

// Board state at `nowHr` on `day`. For trips in progress the final-stop ETA is updated with the
// delay observed at the last completed stop (heuristic, outside the conformal guarantee).
export function snapshot(rows, m, C, day, nowHr, aciAlpha) {
  const byTrip = new Map();
  for (const r of rows) if (r.day === day) { if (!byTrip.has(r.trip)) byTrip.set(r.trip, []); byTrip.get(r.trip)[r.j] = r; }
  const out = [];
  for (const [t, rs] of byTrip) {
    const last = rs[rs.length - 1], n = rs.length;
    const end = t.stops[n - 1].arriveHr + t.stops[n - 1].dwell / 60;
    const done = t.stops.filter(s => s.arriveHr <= nowHr).length;
    const deadlineMin = appointment(m, last);
    let state, status;
    if (t.start > nowHr) { state = 'Parked'; status = 'ready'; }
    else if (end <= nowHr) { state = 'Completed'; status = 'completed'; }
    else { const atStop = t.stops.find(s => s.arriveHr <= nowHr && s.arriveHr + s.dwell / 60 > nowHr); state = atStop ? 'Unloading' : 'Driving'; status = 'onTime'; }
    const stopBands = rs.map(r => { const [lo, hi] = interval(aciAlpha ? 'aci' : 'mondrian', r, m, C, aciAlpha); return { lo, hi, mid: predict(m, r.x), actual: r.y, store: r.trip.stops[r.j].store, arrived: t.stops[r.j].arriveHr <= nowHr }; });
    let pLate = lateProbability(last, m, C, deadlineMin);
    let etaMid = predict(m, last.x), etaLo = stopBands[n - 1].lo, etaHi = stopBands[n - 1].hi;
    if (state !== 'Parked' && state !== 'Completed' && done > 0) {
      const rj = rs[done - 1], delay = rj.y - predict(m, rj.x);
      const sF = scale(m, last.x), sJ = scale(m, rj.x), sRem = Math.sqrt(Math.max(4, sF * sF - sJ * sJ));
      etaMid += delay; etaLo += delay; etaHi += delay;
      const z = (deadlineMin - etaMid) / sRem;
      const arr = C.calUp; let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= z) lo = mid + 1; else hi = mid; }
      pLate = (arr.length - lo + 1) / (arr.length + 1);
    }
    if (state === 'Completed') pLate = last.y > deadlineMin ? 1 : 0;
    if ((state === 'Driving' || state === 'Unloading') && pLate > 0.2) status = 'atRisk';
    out.push({ id: t.id, trip: t, start: t.start, endActual: end, state, status, done, n, refrigerated: t.refrigerated,
      etaMid: t.start + etaMid / 60, etaLo: t.start + etaLo / 60, etaHi: t.start + etaHi / 60, deadline: t.start + deadlineMin / 60,
      pOnTime: 1 - pLate, lateActual: last.y > deadlineMin,
      // driving time: actual for completed trips, planned (point ETA minus expected dwell) otherwise, so the board never shows the future
      driveMin: state === 'Completed' ? t.stops.reduce((a, s) => a + s.drive, 0) : Math.max(1, predict(m, last.x) - last.x[9]), stopBands, wx: t.wx });
  }
  return out.sort((a, b) => a.start - b.start);
}

// Rebuild network + history objects from the committed JSON
export function fromJSON(J) {
  const net = { dcs: J.network.dcs, stores: J.network.stores };
  const trips = J.trips.map(t => ({ day: t.d, id: t.id, dc: t.dc, start: t.s, wx: t.wx, refrigerated: !!t.rf,
    stops: t.st.map((s, idx) => ({ store: s[0], from: s[1], idx, arriveHr: s[2], drive: s[3], dwell: s[4] })) }));
  return { net, hist: { trips, weather: J.weather, shiftDay: J.meta.shiftDay } };
}
