// Replays every Cricsheet match in data/cricsheet through the adapter and the
// engine, then checks the result against Cricsheet's own numbers: innings
// totals, the result, every batter's runs and balls, every bowler's figures.
// Usage: node tools/check-replay.js [--timeline]
const fs = require('fs');
const path = require('path');
const E = require('../engine.js');
const Cs = require('../adapters/cricsheet.js');
const LEVELS = require('../data/levels.js');

const dir = path.join(__dirname, '..', 'data', 'cricsheet');
const NOT_BOWLER = new Set(['run out', 'retired hurt', 'retired out', 'retired not out', 'obstructing the field', 'timed out', 'handled the ball']);

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const cs = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const feed = Cs.toFeed(cs, { id: path.basename(file, '.json'), levels: LEVELS });
  const m = E.createMatch(feed.info);
  for (const item of feed.items) E.push(m, item);
  const problems = [];
  const expect = (what, want, got) => { if (want !== got) problems.push(`${what}: Cricsheet ${want}, Dip In ${got}`); };

  cs.innings.filter((x) => !x.super_over).slice(0, 2).forEach((inn, k) => {
    const ds = inn.overs.flatMap((o) => o.deliveries);
    expect(`${inn.team} total`, ds.reduce((a, d) => a + d.runs.total, 0), m.innings[k].total);
    expect(`${inn.team} wickets`, ds.filter((d) => d.wickets && !/retired hurt|retired not out/.test(d.wickets[0].kind)).length, m.innings[k].wkts);
    const st = E.stateAt(m, m.innings[k].endIdx);
    const bat = {};
    const bowl = {};
    for (const d of ds) {
      const b = bat[d.batter] || (bat[d.batter] = { runs: 0, balls: 0 });
      b.runs += d.runs.batter;
      if (!(d.extras && d.extras.wides)) b.balls++;
      const w = bowl[d.bowler] || (bowl[d.bowler] = { runs: 0, wkts: 0 });
      const ex = d.extras || {};
      w.runs += d.runs.total - (ex.byes || 0) - (ex.legbyes || 0) - (ex.penalty || 0);
      if (d.wickets && !NOT_BOWLER.has(d.wickets[0].kind)) w.wkts++;
    }
    // Every batter's line, read back from the engine's scorecard for that innings.
    const card = {};
    for (let i = m.innings[k].startIdx; i <= m.innings[k].endIdx; i++) {
      const d = m.balls[i];
      const c = card[d.striker] || (card[d.striker] = { runs: 0, balls: 0 });
      c.runs += d.runs;
      if (d.legal || d.extra === 'nb') c.balls++;
    }
    for (const [name, b] of Object.entries(bat)) {
      expect(`${name} runs`, b.runs, (card[name] || {}).runs);
      expect(`${name} balls`, b.balls, (card[name] || {}).balls);
    }
    for (const [name, w] of Object.entries(bowl)) {
      const fig = st.topBowlers.concat(st.bowlersLeft.map((x) => ({ name: x.name, figures: x.figures }))).find((x) => x.name === name);
      const [, , runs, wkts] = fig.figures.split('-').map(Number);
      expect(`${name} runs conceded`, w.runs, runs);
      expect(`${name} wickets`, w.wkts, wkts);
    }
  });
  // Who was really at the crease after each ball, from the next ball.
  for (let i = 0; i < m.balls.length - 1; i++) {
    const d = m.balls[i];
    const n = m.balls[i + 1];
    if (n.inn === d.inn && (d.next.s !== n.striker || d.next.ns !== n.nonStriker)) problems.push(`crease after ${d.label}: ${JSON.stringify(d.next)}`);
  }
  const out = cs.info.outcome || {};
  const winnerId = m.result && m.result.winner;
  expect('winner', out.winner || null, winnerId ? m.info.teams[winnerId].name : null);
  if (out.by && out.by.runs) expect('margin', `${out.by.runs} run${out.by.runs === 1 ? '' : 's'}`, m.result.margin);
  if (out.by && out.by.wickets) expect('margin', `${out.by.wickets} wicket${out.by.wickets === 1 ? '' : 's'}`, m.result.margin);

  const label = `${feed.info.event}: ${m.result ? m.result.text : 'no result'} (${m.balls.length} balls)`;
  if (problems.length) {
    console.log(`FAIL ${file} ${label}`);
    for (const p of problems.slice(0, 25)) console.log('  ' + p);
    process.exitCode = 1;
  } else console.log(`ok   ${file} ${label}`);

  if (process.argv.includes('--timeline')) {
    m.balls.forEach((d, i) => {
      for (const a of d.alerts) console.log(`   ! [${d.inn}:${d.label}] ${a.kind}: ${a.title} | ${a.body}`);
      const end = (d.legal && d.legalBalls % 6 === 0) || i === m.balls.length - 1;
      if (end) console.log(`inn${d.inn} ${E.oversLabel(d.legalBalls).padStart(4)} ${String(d.total).padStart(3)}/${d.wkts}  chase win ${String(Math.round(d.wp * 100)).padStart(3)}%  tension ${String(d.tension).padStart(3)}`);
    });
  }
}

