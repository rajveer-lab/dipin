// Stress test: replays every T20 in one or more folders of Cricsheet files
// through the adapter and engine, one ball at a time as a live feed would,
// and checks the engine's scoreboard against Cricsheet's: innings totals,
// wickets, who is at the crease, and the result. Groups matches by what kind
// of match they were (rain-shortened, tied, no result...) so a failure says
// where the engine falls short.
//   node tools/replay-all.js <folder> [<folder> ...] [--list kind]
const fs = require('fs');
const path = require('path');
const E = require(process.env.ENGINE ? path.resolve(process.env.ENGINE) : '../engine.js');
const Cs = require('../adapters/cricsheet.js');

const args = process.argv.slice(2);
const listKind = args.includes('--list') ? args[args.indexOf('--list') + 1] : null;
const dirs = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--list');

const LEVELS = null;
const kinds = {};
const problems = {};
const note = (kind, file, what) => {
  const p = problems[what] || (problems[what] = { n: 0, eg: [] });
  p.n++;
  if (p.eg.length < 3) p.eg.push(file);
  if (listKind === what) console.log(`${what}: ${file}`);
};

function kindOf(cs) {
  const o = cs.info.outcome || {};
  const reg = cs.innings.filter((x) => !x.super_over);
  if (o.result === 'no result') return 'no result';
  if (o.method === 'Awarded' || reg.length < 2) return 'awarded or one innings';
  if (o.method || (reg[1].target && reg[1].target.overs < cs.info.overs)) return 'rain-shortened';
  if (o.result === 'tie') return 'tie';
  return 'normal';
}

let total = 0;
for (const dir of dirs) {
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const cs = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (cs.info.match_type !== 'T20' || cs.info.overs !== 20) continue;
    total++;
    const file = `${path.basename(dir)}/${f}`;
    const kind = kindOf(cs);
    const k = kinds[kind] || (kinds[kind] = { n: 0, ok: 0 });
    k.n++;
    const bad = new Set();
    const flag = (what) => { if (!bad.has(what)) { bad.add(what); note(kind, file, `${kind}: ${what}`); } };
    let m;
    try {
      const feed = Cs.toFeed(cs, { id: f, scoring: LEVELS ? LEVELS(cs) : null });
      m = E.createMatch(feed.info);
      for (const item of feed.items || feed.balls) (E.push || E.addBall)(m, item);
    } catch (e) {
      flag(`crash: ${String(e.message || e).replace(/\d+/g, 'N').slice(0, 70)}`);
      continue;
    }
    const reg = cs.innings.filter((x) => !x.super_over && x.overs);
    const sums = reg.slice(0, 2).map((inn, i) => {
      const ds = inn.overs.flatMap((o) => o.deliveries);
      const runs = ds.reduce((a, d) => a + d.runs.total, 0) + ((inn.penalty_runs && inn.penalty_runs.pre) || 0) + ((inn.penalty_runs && inn.penalty_runs.post) || 0);
      const wkts = ds.reduce((a, d) => a + (d.wickets || []).filter((w) => !/retired hurt|retired not out/.test(w.kind)).length, 0);
      if (runs !== m.innings[i].total) flag('innings total differs');
      if (wkts !== m.innings[i].wkts) flag('wickets differ');
      return { runs, wkts };
    });
    for (let i = 0; i < m.balls.length - 1; i++) {
      const d = m.balls[i];
      const n = m.balls[i + 1];
      if (n.inn === d.inn && (d.next.s !== n.striker || d.next.ns !== n.nonStriker)) { flag('crease differs from next ball'); break; }
    }
    if (m.balls.some((d) => !Number.isFinite(d.wp) || !Number.isFinite(d.tension))) flag('win chance or tension not a number');
    const o = cs.info.outcome || {};
    const r = m.result;
    // Some files' balls do not add up to their own result (a run missing from
    // the record). That is the data, not the engine; count it apart.
    if (kind === 'normal' && sums.length === 2 && o.winner && o.by) {
      const [a, b] = sums;
      const firstWon = o.winner === reg[0].team;
      const fits = firstWon ? o.by.runs === a.runs - b.runs : b.runs > a.runs && o.by.wickets === 10 - b.wkts;
      if (!fits) { flag('data: Cricsheet result does not match its own balls'); bad.add('data only'); }
    }
    if (bad.has('data only')) { k.dataOnly = (k.dataOnly || 0) + 1; continue; }
    if (o.result === 'no result') { if (r && r.winner) flag('winner given for a no result'); }
    else if (o.result === 'tie') { if (!r || !/tied/i.test(r.text)) flag('tie not recognised'); }
    else if (o.winner) {
      const winnerId = r && r.winner;
      const got = winnerId && m.info.teams[winnerId] ? m.info.teams[winnerId].name : null;
      if (!r) flag('no result reached');
      else if (got !== o.winner) flag('wrong winner');
      else if (o.by && o.by.runs && r.margin !== `${o.by.runs} run${o.by.runs === 1 ? '' : 's'}`) flag('run margin differs');
      else if (o.by && o.by.wickets && r.margin !== `${o.by.wickets} wicket${o.by.wickets === 1 ? '' : 's'}`) flag('wicket margin differs');
    }
    if (!bad.size) k.ok++;
  }
}

console.log(`${total} T20 matches`);
for (const [kind, k] of Object.entries(kinds).sort((a, b) => b[1].n - a[1].n)) {
  const n = k.n - (k.dataOnly || 0);
  console.log(`  ${kind.padEnd(24)} ${String(k.n).padStart(5)} matches, ${String(k.ok).padStart(5)} fully right (${(100 * k.ok / n).toFixed(1)}%)` +
    (k.dataOnly ? `, ${k.dataOnly} left out: Cricsheet's balls disagree with its result` : ''));
}
console.log('problems:');
for (const [what, p] of Object.entries(problems).sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${String(p.n).padStart(5)}  ${what}   e.g. ${p.eg.join(', ')}`);
}
