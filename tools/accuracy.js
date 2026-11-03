// How good are the engine's win chances outside the IPL it was fitted on?
// Scores the shipped model (engine.js) on every completed 20-over match in
// one or more folders of Cricsheet files, competition by competition.
//   node tools/accuracy.js <folder> [<folder> ...] [--in-season K]
// Competitions are told apart as the adapter does (adapters/cricsheet.js,
// competitionOf), so this scores exactly what data/levels.js gives the app.
//
// The scoring level for each match is its competition's average first-innings
// total in the previous season, which is all a live app would know. Each
// competition is scored twice: with that level, and with the IPL default the
// engine falls back on, to show what knowing the level is worth.
// --in-season K also folds in this season's matches so far, weighing last
// season like K matches.
const fs = require('fs');
const path = require('path');
const E = require(process.env.ENGINE ? path.resolve(process.env.ENGINE) : '../engine.js');
const Cs = require('../adapters/cricsheet.js');

const args = process.argv.slice(2);
const IN_SEASON = args.includes('--in-season') ? Number(args[args.indexOf('--in-season') + 1]) : null;
// --edge: also learn each competition's chasing edge (a shift in the odds,
// from dew, grounds, depth of batting) from its earlier seasons only.
const EDGE = args.includes('--edge');
const sig = (x) => 1 / (1 + Math.exp(-x));
const logit = (p) => Math.log(p / (1 - p));
// The shift that best fits these chase states, each match counting once,
// pulled towards no shift so a handful of matches cannot swing it.
function fitEdge(states, prior = 0.4) {
  let d = 0;
  for (let it = 0; it < 20; it++) {
    let g = -d / (prior * prior);
    let h = 1 / (prior * prior);
    for (const s of states) {
      const p = sig(logit(Math.min(1 - 1e-6, Math.max(1e-6, s.p))) + d);
      g += s.w * (s.y - p);
      h += s.w * p * (1 - p);
    }
    d += g / h;
  }
  return d;
}
const dirs = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--in-season');

const comps = {};
for (const dir of dirs) {
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const cs = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const i = cs.info;
    const o = i.outcome || {};
    if (i.match_type !== 'T20' || i.overs !== 20 || o.method || o.result || !o.winner) continue;
    const reg = cs.innings.filter((x) => !x.super_over && x.overs);
    if (reg.length < 2) continue;
    const comp = Cs.competitionOf(cs);
    const name = comp.key.replace('|male', '').replace('|female', ' (women)');
    const inns = reg.map((inn) => {
      const states = [];
      let r = 0;
      let w = 0;
      let legal = 0;
      for (const ov of inn.overs) {
        let inOver = 0;
        for (const d of ov.deliveries) {
          states.push({ r, w, legal });
          r += d.runs.total;
          w += (d.wickets || []).filter((x) => !/retired hurt|retired not out/.test(x.kind)).length;
          if (!(d.extras && (d.extras.wides || d.extras.noballs))) inOver++;
          legal = ov.over * 6 + Math.min(6, inOver);
        }
      }
      return { total: r, states };
    });
    const c = comps[name] || (comps[name] = { matches: [] });
    c.matches.push({ season: comp.season, date: i.dates[0], inns, chaseWon: o.winner === reg[1].team, target: inns[0].total + 1 });
  }
}

const sumScore = () => ({ n: 0, ll: 0, brier: 0, bins: Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 })) });
function add(s, p, y) {
  p = Math.min(1 - 1e-6, Math.max(1e-6, p));
  s.n++;
  s.ll -= y * Math.log(p) + (1 - y) * Math.log(1 - p);
  s.brier += (p - y) ** 2;
  const b = s.bins[Math.min(9, Math.floor(p * 10))];
  b.n++; b.p += p; b.y += y;
}
// Calibration error: how far, on average, the chance said is from how often it happened.
const calErr = (s) => s.bins.reduce((a, b) => a + (b.n ? Math.abs(b.p - b.y) : 0), 0) / s.n;

const rows = [];
const all = { known: sumScore(), ipl: sumScore() };
for (const [name, c] of Object.entries(comps)) {
  const lv = {};
  for (const m of c.matches) (lv[m.season] = lv[m.season] || []).push(m.inns[0].total);
  const avg = Object.fromEntries(Object.entries(lv).map(([s, a]) => [s, a.reduce((x, y) => x + y, 0) / a.length]));
  const seasons = Object.keys(avg).map(Number).sort((a, b) => a - b);
  const known = { chase: sumScore(), first: sumScore() };
  const ipl = { chase: sumScore(), first: sumScore() };
  let used = 0;
  const soFar = {};
  const history = []; // chase states of earlier seasons, for the edge
  const edgeOf = {};
  c.matches.sort((a, b) => a.date.localeCompare(b.date));
  for (const m of c.matches) {
    const prev = seasons.filter((s) => s < m.season).pop();
    const now = soFar[m.season] || (soFar[m.season] = { n: 0, t: 0 });
    let L = prev == null ? null : avg[prev];
    if (IN_SEASON != null && L != null) L = (L * IN_SEASON + now.t) / (IN_SEASON + now.n);
    now.n++; now.t += m.inns[0].total;
    if (L == null) continue; // first season: no level known yet
    used++;
    const y = m.chaseWon ? 1 : 0;
    if (EDGE && edgeOf[m.season] == null) edgeOf[m.season] = fitEdge(history.filter((h) => h.season < m.season));
    const shift = EDGE ? edgeOf[m.season] : 0;
    const chaseStates = m.inns[1].states.filter((st) => st.w < 10 && st.legal < 120 && st.r < m.target);
    for (const st of chaseStates) history.push({ season: m.season, y, w: 1 / chaseStates.length, p: E.chaseWinChance(2, st.r, st.w, st.legal, m.target, L) });
    for (const [inn, st] of m.inns.flatMap((x, k) => x.states.map((s) => [k + 1, s]))) {
      if (st.w >= 10 || st.legal >= 120 || (inn === 2 && st.r >= m.target)) continue;
      const p0 = E.chaseWinChance(inn, st.r, st.w, st.legal, m.target, L);
      const p = shift ? sig(logit(Math.min(1 - 1e-9, Math.max(1e-9, p0))) + shift) : p0;
      const q = E.chaseWinChance(inn, st.r, st.w, st.legal, m.target, null);
      const key = inn === 2 ? 'chase' : 'first';
      add(known[key], p, y); add(ipl[key], q, y);
      if (inn === 2) { add(all.known, p, y); add(all.ipl, q, y); }
    }
  }
  if (!used) continue;
  const latest = seasons[seasons.length - 1];
  rows.push({ name, used, level: Math.round(avg[latest]), latest, known, ipl, edge: EDGE ? fitEdge(history) : null });
}

rows.sort((a, b) => b.used - a.used);
console.log('Chase win chance, scored ball by ball (lower log loss and Brier are better; calibration error is the average gap between the chance said and how often it happened)\n');
console.log('competition        matches  level   log loss  Brier   cal. err   | with the IPL default level: log loss  cal. err');
for (const r of rows) {
  const k = r.known.chase;
  const d = r.ipl.chase;
  console.log(`${r.name.padEnd(18)} ${String(r.used).padStart(6)}  ${String(r.level).padStart(5)}   ${(k.ll / k.n).toFixed(3)}    ${(k.brier / k.n).toFixed(3)}   ${(100 * calErr(k)).toFixed(1).padStart(4)}%     |                             ${(d.ll / d.n).toFixed(3)}   ${(100 * calErr(d)).toFixed(1).padStart(4)}%` +
    (r.edge != null ? `   edge now ${r.edge >= 0 ? '+' : ''}${r.edge.toFixed(2)}` : ''));
}
console.log(`${'all'.padEnd(18)} ${String(rows.reduce((a, r) => a + r.used, 0)).padStart(6)}          ${(all.known.ll / all.known.n).toFixed(3)}    ${(all.known.brier / all.known.n).toFixed(3)}   ${(100 * calErr(all.known)).toFixed(1).padStart(4)}%     |                             ${(all.ipl.ll / all.ipl.n).toFixed(3)}   ${(100 * calErr(all.ipl)).toFixed(1).padStart(4)}%`);
console.log('\nFirst innings (chance the side batting second wins):');
for (const r of rows) {
  const k = r.known.first;
  console.log(`${r.name.padEnd(18)} log loss ${(k.ll / k.n).toFixed(3)}  cal. err ${(100 * calErr(k)).toFixed(1)}%`);
}
console.log('\nChases by competition, said (middle of each tenth) vs happened:');
for (const r of rows) {
  const b = r.known.chase.bins;
  console.log(`${r.name.slice(0, 26).padEnd(26)} ` + b.map((x, i) => (x.n >= 200 ? `${i * 10 + 5}:${(100 * x.y / x.n).toFixed(0)}` : `${i * 10 + 5}:-`).padStart(7)).join(''));
}
console.log('\nAll chases, said vs happened:');
for (let i = 0; i < 10; i++) {
  const b = all.known.bins[i];
  if (b.n) console.log(`  said ${String(i * 10).padStart(2)}-${String(i * 10 + 10).padStart(3)}%: won ${(100 * b.y / b.n).toFixed(0).padStart(3)}% of ${b.n}`);
}
