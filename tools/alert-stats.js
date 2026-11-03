// How well do Dip In's "watch now" pings pick the matches worth watching?
// Replays every Cricsheet match in the folders through the adapter and
// engine, with the scoring level and chasing edge from data/levels.js as the
// app would use them, then checks by competition: of the matches that went
// down to the wire, how many pinged a fan in time; of the one-sided ones, how
// many pinged them for nothing.
//   node tools/alert-stats.js <folder> [<folder> ...]
// NO_LEVELS=1 leaves the table out, as a feed with no competition info would.
const fs = require('fs');
const path = require('path');
const E = require(process.env.ENGINE ? path.resolve(process.env.ENGINE) : '../engine.js');
const Cs = require('../adapters/cricsheet.js');
const LEVELS = process.env.NO_LEVELS ? null : require('../data/levels.js');

const dirs = process.argv.slice(2);
const KINDS = ['close', 'middle', 'one-sided'];
const by = {};
const tensions = [];
for (const dir of dirs) {
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const cs = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const i = cs.info;
    const o = i.outcome || {};
    if (i.match_type !== 'T20' || i.overs !== 20 || o.method || o.result || !o.winner) continue;
    if (cs.innings.filter((x) => !x.super_over && x.overs).length < 2) continue;
    const feed = Cs.toFeed(cs, { levels: LEVELS });
    const m = E.createMatch(feed.info);
    for (const item of feed.items) E.push(m, item);
    if (!m.result) continue;
    const last = m.balls[m.balls.length - 1];
    const margin = o.by || {};
    const ballsLeft = 120 - last.legalBalls;
    let kind = 'middle';
    if ((margin.runs && margin.runs <= 8) || (margin.wickets && ballsLeft <= 4)) kind = 'close';
    else if ((margin.runs && margin.runs >= 30) || (margin.wickets && (ballsLeft >= 24 || margin.wickets >= 7))) kind = 'one-sided';
    const pings = [];
    // Everything in the "tense moments" group: watch-now pings and the last-over call.
    m.balls.forEach((d, k) => { if (d.alerts.some((a) => a.group === 'tense')) pings.push(k); });
    const row = { pings, lead: pings.length ? m.balls.length - 1 - pings[0] : null };
    const comp = Cs.competitionOf(cs).key.replace('|male', '').replace('|female', ' (women)');
    for (const name of [comp, 'all']) (by[name] || (by[name] = { close: [], middle: [], 'one-sided': [] }))[kind].push(row);
    for (const d of m.balls) if (d.inn === 2) tensions.push(d.tension);
  }
}

const pct = (g) => (g.length ? `${(100 * g.filter((x) => x.pings.length).length / g.length).toFixed(0)}%` : '-');
const lead = (g) => {
  const l = g.filter((x) => x.pings.length).map((x) => x.lead).sort((a, b) => a - b);
  return l.length ? String(l[Math.floor(l.length / 2)]) : '-';
};
const size = (g) => KINDS.reduce((s, k) => s + g[k].length, 0);
console.log(`tension 70+ on ${(100 * tensions.filter((t) => t >= 70).length / tensions.length).toFixed(1)}% of chase balls\n`);
console.log('competition                       close  pinged  lead |  middle  pinged | one-sided  pinged (lower is better)');
const rows = Object.entries(by).sort((a, b) => (a[0] === 'all') - (b[0] === 'all') || size(b[1]) - size(a[1]));
for (const [name, g] of rows) {
  console.log(`${name.slice(0, 32).padEnd(32)} ${String(g.close.length).padStart(6)}  ${pct(g.close).padStart(6)}  ${lead(g.close).padStart(4)} | ${String(g.middle.length).padStart(7)}  ${pct(g.middle).padStart(6)} | ${String(g['one-sided'].length).padStart(9)}  ${pct(g['one-sided']).padStart(6)}`);
}
console.log('\nclose: won by 8 runs or fewer, or with 4 balls or fewer left. one-sided: 30+ runs, or 7+ wickets, or 4+ overs to spare.');
console.log('lead: how many balls before the end the first ping came (median).');
