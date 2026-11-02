// Prints a match over by over: score, win chance, tension and alerts.
// Usage: node tools/inspect.js <seed>
const E = require('../engine.js');

const m = E.simulateMatch(Number(process.argv[2] || E.SEED));
console.log(m.result.text, '| target', m.target);
let last = null;
m.balls.forEach((d, i) => {
  const overEnd = (d.legal && d.legalBalls % 6 === 0) || i === m.balls.length - 1 || (m.balls[i + 1] && m.balls[i + 1].inn !== d.inn);
  for (const a of d.alerts) console.log(`   ! [${d.inn}:${d.label}] ${a.kind}: ${a.title} | ${a.body}`);
  if (overEnd) {
    console.log(`inn${d.inn} ${E.oversLabel(d.legalBalls).padStart(4)}  ${String(d.total).padStart(3)}/${d.wkts}  falcons ${String(Math.round(d.wp * 100)).padStart(3)}%  tension ${String(d.tension).padStart(3)}  ${E.clockLabel(d.t)}`);
  }
  last = d;
});
