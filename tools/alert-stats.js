// How well do Dip In's "watch now" pings pick the matches worth watching?
// Replays every Cricsheet match in a folder through the adapter and engine,
// then checks: of the matches that went down to the wire, how many pinged a
// fan in time; of the one-sided ones, how many pinged them for nothing.
//   node tools/alert-stats.js <folder of Cricsheet JSON files>
const fs = require('fs');
const path = require('path');
const E = require(process.env.ENGINE ? path.resolve(process.env.ENGINE) : '../engine.js');
const Cs = require('../adapters/cricsheet.js');

const dir = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
const raw = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
  .filter((m) => m.info.match_type === 'T20' && m.info.overs === 20 && !m.info.outcome.method && !m.info.outcome.result && m.innings.length >= 2);
// Scoring level per season, as the app would set it.
const seasonOf = (m) => Number(String(m.info.season).slice(0, 4)) + (String(m.info.season).includes('/') ? 1 : 0);
const lv = {};
for (const m of raw) { const s = seasonOf(m); const t = m.innings[0].overs.flatMap((o) => o.deliveries).reduce((a, d) => a + d.runs.total, 0); (lv[s] = lv[s] || []).push(t); }
const level = Object.fromEntries(Object.entries(lv).map(([s, a]) => [s, Math.round(a.reduce((x, y) => x + y, 0) / a.length)]));

const groups = { close: [], middle: [], 'one-sided': [] };
const tensions = [];
for (const cs of raw) {
  const feed = Cs.toFeed(cs, { scoring: level[seasonOf(cs)] });
  const m = E.createMatch(feed.info);
  try { for (const b of feed.balls) E.addBall(m, b); } catch (e) { continue; }
  if (!m.result) continue;
  const last = m.balls[m.balls.length - 1];
  const by = cs.info.outcome.by || {};
  const ballsLeft = 120 - last.legalBalls;
  let kind = 'middle';
  if ((by.runs && by.runs <= 8) || (by.wickets && ballsLeft <= 4)) kind = 'close';
  else if ((by.runs && by.runs >= 30) || (by.wickets && (ballsLeft >= 24 || by.wickets >= 7))) kind = 'one-sided';
  const pings = [];
  // Everything in the "tense moments" group: watch-now pings and the last-over call.
  m.balls.forEach((d, i) => { if (d.alerts.some((a) => a.group === 'tense')) pings.push(i); });
  const end = m.balls.length - 1;
  groups[kind].push({ pings, lead: pings.length ? end - pings[0] : null, end });
  for (const d of m.balls) if (d.inn === 2) tensions.push(d.tension);
}
console.log(`${raw.length} matches; tension 70+ on ${(100 * tensions.filter((t) => t >= 70).length / tensions.length).toFixed(1)}% of chase balls`);
for (const [k, g] of Object.entries(groups)) {
  const hit = g.filter((x) => x.pings.length);
  const leads = hit.map((x) => x.lead).sort((a, b) => a - b);
  const med = leads.length ? leads[Math.floor(leads.length / 2)] : 0;
  console.log(`${k.padEnd(10)} ${String(g.length).padStart(4)} matches: pinged ${(100 * hit.length / g.length).toFixed(0).padStart(3)}%, ` +
    `${(g.reduce((a, x) => a + x.pings.length, 0) / g.length).toFixed(2)} pings each, first ping a median ${med} balls before the end`);
}

