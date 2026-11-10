// Seeded synthetic data for the demo: a DFW-style DC -> store network and 120 days of
// driverless middle-mile trips (44/day). Not Gatik data.
// Usage: node scripts/gen_data.mjs -> data/trips.json
import fs from 'node:fs';
import * as E from '../core/eta.mjs';
const net = E.buildNetwork(7);
const hist = E.generateHistory(net, { days: 120, seed: 20261110, shiftDay: 106, tripsPerDay: 44 });
const r3 = x => Math.round(x * 1000) / 1000;
const out = {
  meta: { generator: 'scripts/gen_data.mjs', seed: 20261110, networkSeed: 7, days: 120, shiftDay: hist.shiftDay, note: 'Synthetic. Lane closure on the I-30 corridor from day 106. Not Gatik data.' },
  network: { dcs: net.dcs, stores: net.stores.map(s => ({ ...s, ll: s.ll.map(r3), dwellMean: r3(s.dwellMean), dwellSpread: r3(s.dwellSpread) })) },
  weather: hist.weather,
  trips: hist.trips.map(t => ({ d: t.day, id: t.id, dc: t.dc, s: r3(t.start), wx: t.wx, rf: t.refrigerated ? 1 : 0,
    st: t.stops.map(s => [s.store, s.from, r3(s.arriveHr), r3(s.drive), r3(s.dwell)]) })),
};
fs.writeFileSync(new URL('../data/trips.json', import.meta.url), JSON.stringify(out));
console.log('trips', out.trips.length, 'bytes', JSON.stringify(out).length);
