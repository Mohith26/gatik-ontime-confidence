// node --test tests/test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as E from '../core/eta.mjs';

const J = JSON.parse(fs.readFileSync(new URL('../data/trips.json', import.meta.url)));
const { net, hist } = E.fromJSON(J);
const { rows } = E.buildRows(net, hist);
const m = E.fitModels(rows);
const C = E.calibrate(rows, m);

test('data: committed trips.json is reproduced exactly by the seeded generator', () => {
  const n2 = E.buildNetwork(7), h2 = E.generateHistory(n2, { days: 120, seed: 20261110, shiftDay: 106, tripsPerDay: 44 });
  assert.equal(h2.trips.length, hist.trips.length);
  for (const i of [0, 777, 5279]) {
    assert.equal(h2.trips[i].id, hist.trips[i].id);
    assert.ok(Math.abs(h2.trips[i].stops.at(-1).arriveHr - hist.trips[i].stops.at(-1).arriveHr) < 1e-3);
  }
});

test('conformal quantile: finite-sample rank ceil((n+1)(1-a)) and Infinity when n is too small', () => {
  const s = Array.from({ length: 19 }, (_, i) => i + 1); // 1..19
  assert.equal(E.conformalQuantile(s, 0.1), 18); // ceil(20*0.9)=18th smallest
  assert.equal(E.conformalQuantile(s, 0.01), Infinity); // ceil(20*.99)=20 > 19
});

test('split conformal: marginal coverage >= 1-alpha on exchangeable synthetic data (many seeds)', () => {
  let covers = 0, total = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const R = E.rng(seed);
    const gen = () => { const x = R() * 10; return { x, y: 2 * x + (0.5 + x / 4) * E.normal(R) }; };
    const cal = Array.from({ length: 99 }, gen), te = gen();
    const q = E.conformalQuantile(cal.map(p => Math.abs(p.y - 2 * p.x) / (0.5 + p.x / 4)), 0.1);
    covers += Math.abs(te.y - 2 * te.x) / (0.5 + te.x / 4) <= q; total++;
  }
  assert.ok(covers / total >= 0.85, `coverage ${covers / total}`); // 0.9 in expectation; 200 draws
});

test('OLS recovers known coefficients', () => {
  const R = E.rng(3), X = [], y = [];
  for (let i = 0; i < 500; i++) { const a = R(), b = R(); X.push([1, a, b]); y.push(3 + 2 * a - 5 * b + 0.01 * E.normal(R)); }
  const w = E.ols(X, y, 0);
  assert.ok(Math.abs(w[0] - 3) < 0.01 && Math.abs(w[1] - 2) < 0.01 && Math.abs(w[2] + 5) < 0.01);
});

test('calibration period: normalised conformal covers ~90% on its own calibration rows and pre-shift test days', () => {
  const cal = rows.filter(r => r.day >= 70 && r.day < 96);
  const cov = cal.filter(r => { const [lo, hi] = E.interval('conformal', r, m, C); return r.y >= lo && r.y <= hi; }).length / cal.length;
  assert.ok(cov >= 0.9 && cov < 0.92, `cal coverage ${cov}`);
  const pre = rows.filter(r => r.day >= 96 && r.day < hist.shiftDay);
  const cp = pre.filter(r => { const [lo, hi] = E.interval('conformal', r, m, C); return r.y >= lo && r.y <= hi; }).length / pre.length;
  assert.ok(cp > 0.87, `pre-shift test coverage ${cp}`);
});

test('evaluation: conformal bands are narrower than Gaussian and route-table bands; ACI beats split conformal after the shift', () => {
  const ev = E.evaluate(rows, m, C);
  const st = ev.stats;
  assert.ok(st.mondrian.meanWidth < st.gaussian.meanWidth && st.gaussian.meanWidth < st.static.meanWidth);
  const post = k => { const d = st[k].byDay.filter(x => x.day >= hist.shiftDay); return d.reduce((a, x) => a + x.cover, 0) / d.length; };
  assert.ok(post('aci') > post('conformal') + 0.02, `aci ${post('aci')} vs conformal ${post('conformal')}`);
  // Gaussian conditional coverage is badly unbalanced across groups; ACI's is tighter
  const spread = k => { const v = Object.values(st[k].byGroup).map(g => g.cover / g.n); return Math.max(...v) - Math.min(...v); };
  assert.ok(spread('aci') < spread('gaussian') / 3);
});

test('late-risk: conformal probabilities beat the Gaussian on Brier score and are monotone in the deadline', () => {
  const rel = E.lateReliability(rows, m, C);
  assert.ok(rel.brier < rel.brierGaussian);
  const r = rows.find(x => x.day === 100);
  const ps = [0, 5, 10, 20, 40].map(sl => E.lateProbability(r, m, C, E.predict(m, r.x) + sl));
  for (let i = 1; i < ps.length; i++) assert.ok(ps[i] <= ps[i - 1]);
  assert.ok(ps[0] > 0.3 && ps[4] < 0.05);
});

test('promises: calibration-tuned conformal promise is near 99% on time with less slack than a flat buffer', () => {
  const pr = E.promises(rows, m, C);
  assert.ok(pr.conformal.ontime > 0.975);
  assert.ok(pr.conformal.slack < pr.mins.slack);
  const fr = E.slackFrontier(rows, m);
  const at = k => fr[k].find(p => p.target === 0.99);
  assert.ok(at('conformal').slack < at('mins').slack && at('conformal').ontime >= 0.99 - 1e-9);
});

test('snapshot: board never reads the future and statuses are consistent with the clock', () => {
  const s = E.snapshot(rows, m, C, 105, 10.75, null);
  for (const t of s) {
    if (t.state === 'Parked') assert.ok(t.start > 10.75 && t.done === 0);
    if (t.state === 'Completed') assert.ok(t.endActual <= 10.75);
    if (t.state !== 'Completed') assert.ok(t.pOnTime >= 0 && t.pOnTime <= 1);
    assert.ok(t.etaLo <= t.etaMid && t.etaMid <= t.etaHi);
  }
  assert.ok(s.some(t => t.state === 'Driving' || t.state === 'Unloading'));
});
