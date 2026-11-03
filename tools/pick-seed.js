// Searches seeds for a match worth demoing: a par-ish first innings, a chase
// that goes to the last over, lead changes, a collapse and a big over.
// Usage: node tools/pick-seed.js [count]
const E = require('../engine.js');

const count = Number(process.argv[2] || 3000);
const rows = [];
for (let seed = 1; seed <= count; seed++) {
  const m = E.simulateMatch(seed);
  const [i1, i2] = m.innings;
  if (i1.total < 158 || i1.total > 188) continue;
  if (!m.result.winner) continue;
  const chase = m.balls.slice(i2.startIdx);
  const lastBall = chase[chase.length - 1];
  if (lastBall.legalBalls < 117) continue;
  let flips = 0;
  for (let i = 1; i < chase.length; i++) if ((chase[i].wp - 0.5) * (chase[i - 1].wp - 0.5) < 0) flips++;
  const kinds = new Set(m.balls.flatMap((d) => d.alerts.map((a) => a.kind)));
  const tenseCount = m.balls.filter((d) => d.alerts.some((a) => a.kind === 'tense')).length;
  const maxT1 = Math.max(...m.balls.slice(0, i2.startIdx).map((d) => d.tension));
  const score = flips + (kinds.has('collapse') ? 3 : 0) + (kinds.has('bigover') ? 2 : 0) + (kinds.has('bigwicket') ? 2 : 0)
    + (kinds.has('lastover') ? 3 : 0) + (lastBall.legalBalls === 120 ? 2 : 0) + Math.min(3, tenseCount);
  rows.push({ seed, score, first: `${i1.total}/${i1.wkts}`, chase: `${i2.total}/${i2.wkts} (${E.oversLabel(i2.legal)})`,
    result: m.result.text, flips, tense: tenseCount, maxT1, kinds: [...kinds].join(',') });
}
rows.sort((a, b) => b.score - a.score);
console.table(rows.slice(0, 15));

