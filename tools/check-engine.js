// Regression check for the engine.
//   node tools/check-engine.js --write   record what the demo match produces now
//   node tools/check-engine.js           compare against that record, then check
//                                        that a ball-by-ball feed rebuilds the
//                                        same match as the simulator does
const fs = require('fs');
const path = require('path');
const E = require('../engine.js');

const GOLDEN = path.join(__dirname, 'golden-sim.json');
const QUESTIONS = ['What do they need?', 'Is this a good score here?', 'Who is the danger man?', 'Can they still win?', 'Why is the tension so high?', 'What is a free hit?'];

function ballView(d) {
  return {
    inn: d.inn, over: d.over, striker: d.striker, nonStriker: d.nonStriker, bowler: d.bowler,
    runs: d.runs, extras: d.extras, extra: d.extra, legal: d.legal, freeHit: d.freeHit,
    wicket: d.wicket && { kind: d.wicket.kind, out: d.wicket.out, bowler: d.wicket.bowler, fielder: d.wicket.fielder, how: d.wicket.how },
    text: d.text, t: d.t, total: d.total, wkts: d.wkts, legalBalls: d.legalBalls, label: d.label, next: d.next,
    wp: d.wp, tension: d.tension, alerts: d.alerts,
  };
}

// Everything the app reads from the engine for one match.
function record(m) {
  const B = m.balls;
  const last = B.length - 1;
  const overEnd = (inn, overs) => B.findIndex((d) => d.inn === inn && d.legal && d.legalBalls === overs * 6);
  const inn1End = m.innings[0].endIdx;
  const windows = [[overEnd(1, 14), overEnd(2, 8)], [-1, 40], [30, 90], [100, 150], [inn1End - 6, inn1End + 8], [180, last], [last - 25, last]];
  const out = {
    result: m.result.text, target: m.target,
    innings: m.innings.map((i) => ({ inn: i.inn, total: i.total, wkts: i.wkts, legal: i.legal, startIdx: i.startIdx, endIdx: i.endIdx })),
    balls: B.map(ballView), states: [], reasons: [], answers: [], windows: [],
  };
  for (let i = 0; i <= last; i++) {
    const s = E.stateAt(m, i);
    out.states.push(s);
    out.reasons.push(E.tensionReason(s));
    if (i % 10 === 0 || i === last) out.answers.push(QUESTIONS.map((q) => E.localAnswer(q, s)));
  }
  for (const [from, to] of windows) {
    const f = E.windowFacts(m, from, to);
    out.windows.push({ from, to, facts: f, en: E.localCatchUp(f, 'en'), hi: E.localCatchUp(f, 'hinglish') });
  }
  return out;
}

// Deep compare, reporting paths. Keys the new engine added are allowed; keys
// that were renamed are mapped through RENAMED before comparing.
const RENAMED = { falconsChance: 'chaseChance' };
function diff(a, b, at, out) {
  if (out.length >= 25) return;
  if (a === b) return;
  if (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9) return;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) { out.push(`${at}: array vs object`); return; }
    if (Array.isArray(a) && a.length !== b.length) out.push(`${at}: length ${a.length} vs ${b.length}`);
    for (const k of Object.keys(a)) {
      const nk = k in b ? k : RENAMED[k] || k;
      if (!(nk in b)) { out.push(`${at}.${k}: missing`); continue; }
      diff(a[k], b[nk], `${at}.${k}`, out);
    }
    return;
  }
  out.push(`${at}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}

function report(label, problems) {
  if (problems.length) {
    console.log(`FAIL ${label}`);
    for (const p of problems) console.log('  ' + p);
    process.exitCode = 1;
  } else console.log(`ok   ${label}`);
}

const sim = E.simulateMatch(E.SEED);
const now = JSON.parse(JSON.stringify(record(sim)));

if (process.argv.includes('--write')) {
  fs.writeFileSync(GOLDEN, JSON.stringify(now));
  console.log(`recorded ${now.balls.length} balls, ${now.states.length} states, ${now.windows.length} catch-up windows -> ${path.relative(process.cwd(), GOLDEN)}`);
  process.exit(0);
}

const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
const p1 = [];
diff(golden, now, 'sim', p1);
report(`demo match unchanged (${golden.balls.length} balls, ${golden.states.length} states, ${golden.windows.length} catch-ups)`, p1);

if (E.createMatch) {
  // Replay the simulator's feed the way a live adapter would: through JSON,
  // one ball at a time, with nothing but the raw ball facts.
  const feed = JSON.parse(JSON.stringify(E.simulateFeed(E.SEED)));
  const live = E.createMatch(feed.info);
  for (const ball of feed.balls) E.addBall(live, ball);
  const p2 = [];
  diff(golden, JSON.parse(JSON.stringify(record(live))), 'feed', p2);
  report('ball-by-ball feed rebuilds the same match', p2);

  // A feed that does not say who is at the crease after each ball: the engine
  // works it out, and fills in a new batter's name when the next ball arrives.
  const bare = E.createMatch(feed.info);
  for (const ball of feed.balls) { const b = Object.assign({}, ball); delete b.next; E.addBall(bare, b); }
  const p3 = [];
  const g = JSON.parse(JSON.stringify(golden));
  const r = JSON.parse(JSON.stringify(record(bare)));
  for (const i of [g.innings[0].endIdx, g.innings[1].endIdx]) { delete g.balls[i].next; delete r.balls[i].next; } // nobody bats after the last ball
  diff(g, r, 'bare', p3);
  report('feed without crease info rebuilds the same match', p3);

  // Mid-match: a match built from part of the feed must agree with the full
  // match at that point, apart from not knowing how it ends.
  const cut = 150;
  const part = E.createMatch(feed.info);
  for (const ball of feed.balls.slice(0, cut + 1)) E.addBall(part, ball);
  const p4 = [];
  diff(golden.balls.slice(0, cut + 1), JSON.parse(JSON.stringify(part.balls.map(ballView))), 'partial', p4);
  const sp = E.stateAt(part, cut);
  if (sp.matchOver || sp.inningsOver) p4.push(`partial: in-progress match reported as over`);
  diff(golden.states[cut], JSON.parse(JSON.stringify(sp)), 'partial.state', p4);
  report(`match in progress (${cut + 1} balls in) matches the full match at that ball`, p4);
}

