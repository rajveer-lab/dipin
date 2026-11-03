// Fits Dip In's win-chance model to real T20 matches from Cricsheet, and
// tests it against the original hand-tuned model on seasons it never saw.
//   node tools/calibrate.js <folder of Cricsheet JSON files> [--test-from 2024]
// Download the folder from https://cricsheet.org/downloads/ (e.g. ipl_json.zip).
//
// The model, in the spirit of the DLS resource table:
//   runs still to come  ~  L0 x R(b, w) x M(b, L),  spread  L0 x S(b, w) x M(b, L)
// b is balls left, w wickets in hand. R is the share of a full innings' runs
// still to come at the reference level L0, fitted on the steadier seasons.
// L is the scoring level now (typical first-innings total). M scales for it,
// but only the runs from overs 1-15: IPL first innings went from about 168
// (2019) to 196 (2026) while the last five overs stayed at about 52 runs.
// Chase chance = sigmoid(a + b z + c t + d z t), z = (runs to come - need + 0.5) / spread,
// t = how far through the innings.
const fs = require('fs');
const path = require('path');

//   --test-from Y   hold out seasons Y and later for testing (default 2024)
//   --final         fit on every season, for the numbers that go in engine.js
//   --ds X          fix how much death overs follow the level (else chosen on Y-1)
const dir = process.argv[2];
if (!dir) { console.error('usage: node tools/calibrate.js <cricsheet json folder> [--test-from 2024 | --final] [--ds 0.5]'); process.exit(1); }
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const FINAL = process.argv.includes('--final');
const TEST_FROM = FINAL ? Infinity : Number(arg('--test-from') || 2024);
const FIXED_DS = arg('--ds') != null ? Number(arg('--ds')) : null;

// ---------- read matches ----------
const matches = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const i = m.info;
  if (i.match_type !== 'T20' || i.overs !== 20 || i.outcome.method || i.outcome.result || m.innings.length < 2) continue;
  const inns = m.innings.slice(0, 2).map((inn) => {
    const states = [];
    let r = 0, w = 0, legal = 0;
    states.push({ b: 120, w: 10, r: 0 });
    for (const o of inn.overs) for (const d of o.deliveries) {
      r += d.runs.total;
      if (d.wickets) w += d.wickets.filter((x) => !/retired hurt|retired not out/.test(x.kind)).length;
      const ex = d.extras || {};
      if (!ex.wides && !ex.noballs) legal++;
      states.push({ b: Math.max(0, 120 - legal), w: Math.max(0, 10 - w), r }); // the odd 7-ball over
    }
    return { team: inn.team, total: r, states };
  });
  const season = Number(String(i.season).slice(0, 4)) + (String(i.season).includes('/') ? 1 : 0);
  matches.push({ id: path.basename(f, '.json'), season, inns, chaseWon: i.outcome.winner === inns[1].team, target: inns[0].total + 1 });
}
const level = {};
for (const m of matches) { const s = level[m.season] || (level[m.season] = { n: 0, t: 0 }); s.n++; s.t += m.inns[0].total; }
for (const s of Object.values(level)) s.avg = s.t / s.n;
const seasons = Object.keys(level).map(Number).sort((a, b) => a - b);
// Scoring level used for a match: its own season when fitting; when testing,
// the previous season's, which is all a live app would know.
const fitLevel = (m) => level[m.season].avg;
const liveLevel = (m) => { const prev = seasons.filter((s) => s < m.season).pop(); return level[prev || m.season].avg; };
const train = matches.filter((m) => m.season < TEST_FROM);
const test = matches.filter((m) => m.season >= TEST_FROM);
console.log(`${matches.length} matches (${train.length} to fit, ${test.length} to test from ${TEST_FROM})`);
console.log('first-innings average by season:', seasons.map((s) => `${s}:${level[s].avg.toFixed(0)}`).join(' '));

// ---------- 1. share of runs still to come, R(b, w) ----------
const cell = () => Array.from({ length: 121 }, () => Array.from({ length: 11 }, () => ({ n: 0, s: 0, ss: 0 })));
const C = cell();
// The shape comes from seasons before the scoring boom, whose levels sit close
// together; L0 is their average.
const SHAPE_MAX_LEVEL = 175;
const shapeSet = train.filter((m) => fitLevel(m) <= SHAPE_MAX_LEVEL);
const L0 = +(shapeSet.reduce((a, m) => a + fitLevel(m), 0) / shapeSet.length).toFixed(1);
for (const m of shapeSet) {
  const L = fitLevel(m);
  const inn = m.inns[0];
  for (const st of inn.states) {
    if (st.w === 0 || st.b === 0) continue;
    const y = (inn.total - st.r) / L;
    const c = C[st.b][st.w]; c.n++; c.s += y; c.ss += y * y;
  }
}
// DLS shape: R(b, w) = F_w (1 - exp(-k b / F_w)). Every side scores the
// next few balls at about the same rate k; wickets in hand set the ceiling
// F_w on what is left. Grid over k, then a 1-D fit of each F_w, then force F
// to rise with wickets in hand.
function cellErr(w, k, F) {
  let err = 0;
  for (let b = 1; b <= 120; b++) { const c = C[b][w]; if (!c.n) continue; const g = F * (1 - Math.exp(-k * b / F)); err += c.ss - 2 * g * c.s + c.n * g * g; }
  return err;
}
function fitF(w, k) {
  let best = null;
  for (let j = 0; j <= 600; j++) { const F = 0.01 * Math.pow(1.012, j); const e = cellErr(w, k, F); if (!best || e < best.e) best = { F, e }; }
  return best;
}
function pav(vals, weights) { // pool adjacent violators: nearest non-decreasing sequence
  const blocks = vals.map((v, i) => ({ v, w: weights[i], n: 1 }));
  for (let i = 0; i < blocks.length - 1;) {
    if (blocks[i].v > blocks[i + 1].v) {
      const a = blocks[i], b = blocks[i + 1];
      blocks.splice(i, 2, { v: (a.v * a.w + b.v * b.w) / (a.w + b.w), w: a.w + b.w, n: a.n + b.n });
      if (i > 0) i--;
    } else i++;
  }
  return blocks.flatMap((b) => Array(b.n).fill(b.v));
}
let fit = null;
for (let j = 0; j <= 80; j++) {
  const k = 0.006 + j * 0.0001;
  const Fs = [];
  let e = 0;
  for (let w = 1; w <= 10; w++) { const f = fitF(w, k); Fs.push(f.F); e += f.e; }
  if (!fit || e < fit.e) fit = { k, Fs, e };
}
const weightsW = Array.from({ length: 10 }, (_, i) => { let n = 0; for (let b = 1; b <= 120; b++) n += C[b][i + 1].n; return n; });
const K = +fit.k.toFixed(5);
const F_W = pav(fit.Fs, weightsW).map((v) => +v.toFixed(4));
const Rf = (b, w) => (w <= 0 || b <= 0 ? 0 : F_W[Math.min(10, w) - 1] * (1 - Math.exp(-K * b / F_W[Math.min(10, w) - 1])));

// ---------- 2. spread, S(b, w) = s1 R^p (fitted in log space) ----------
let sx = 0, sy = 0, sxx = 0, sxy = 0, sn = 0;
for (let b = 1; b <= 120; b++) for (let w = 1; w <= 10; w++) {
  const c = C[b][w]; if (c.n < 30) continue;
  const mean = c.s / c.n;
  const sd = Math.sqrt(Math.max(0, c.ss / c.n - mean * mean));
  if (!(sd > 0)) continue;
  const x = Math.log(Rf(b, w)), y = Math.log(sd);
  sx += c.n * x; sy += c.n * y; sxx += c.n * x * x; sxy += c.n * x * y; sn += c.n;
}
const SP = +((sn * sxy - sx * sy) / (sn * sxx - sx * sx)).toFixed(4);
const S1 = +Math.exp((sy - SP * sx) / sn).toFixed(4);
const Sf = (b, w) => S1 * Math.pow(Rf(b, w), SP);

// Level scaling: runs from the death overs (last 30 balls) follow only part
// of the change in level (DS, 0 = not at all, 1 = fully); runs before them
// make up the rest, so a full innings comes to L.
const DEATH = 30;
let DS = 0.5;
function M(b, L) {
  const r0 = Rf(b, 10);
  if (r0 <= 0) return 1;
  const d0 = Rf(Math.min(b, DEATH), 10);
  const rho = L / L0;
  const md = 1 + DS * (rho - 1);
  const m = (Rf(120, 10) * rho - Rf(DEATH, 10) * md) / (Rf(120, 10) - Rf(DEATH, 10));
  return (d0 * md + (r0 - d0) * m) / r0;
}
const expRem = (b, w, L) => L0 * Rf(b, w) * M(b, L);
const sdRem = (b, w, L) => L0 * Sf(b, w) * M(b, L);

// ---------- 3. chase and first-innings calibration (logistic on z) ----------
function zChase(st, target, L) {
  const need = target - st.r;
  return (expRem(st.b, st.w, L) - need + 0.5) / sdRem(st.b, st.w, L);
}
function zFirst(st, L) {
  const proj = st.r + expRem(st.b, st.w, L);
  return (expRem(120, 10, L) - proj - 0.5) / Math.sqrt(sdRem(120, 10, L) ** 2 + sdRem(st.b, st.w, L) ** 2);
}
function rows(set, inn, levelOf) {
  const out = [];
  for (const m of set) {
    const L = levelOf(m);
    for (const st of m.inns[inn - 1].states) {
      if (inn === 2 && (st.r >= m.target || st.b === 0 || st.w === 0)) continue;
      if (inn === 1 && (st.b === 0 || st.w === 0)) continue;
      out.push({ m, st, L, y: m.chaseWon ? 1 : 0 });
    }
  }
  return out;
}
const sig = (x) => 1 / (1 + Math.exp(-x));
// Logistic regression by Newton's method. Features: 1, z, how far through
// the innings (t), and z x t, so the fit can be surer or less sure late on.
const feats = (z, b) => { const t = 1 - b / 120; return [1, z, t, z * t]; };
function solve(H, g) {
  const n = g.length;
  const A = H.map((row, i) => row.concat([g[i]]));
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k]; }
  }
  return A.map((row, i) => row[n] / row[i]);
}
function fitLogistic(data, zOf) {
  let beta = [0, 1, 0, 0];
  for (let it = 0; it < 30; it++) {
    const g = [0, 0, 0, 0];
    const H = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
    for (const r of data) {
      const x = feats(zOf(r), r.st.b);
      const p = sig(x.reduce((s, xi, i) => s + xi * beta[i], 0));
      const e = r.y - p;
      const v = p * (1 - p);
      for (let i = 0; i < 4; i++) { g[i] += e * x[i]; for (let j = 0; j < 4; j++) H[i][j] += v * x[i] * x[j]; }
    }
    const step = solve(H, g);
    beta = beta.map((b, i) => b + step[i]);
    if (Math.max(...step.map(Math.abs)) < 1e-9) break;
  }
  return beta.map((b) => +b.toFixed(4));
}
const prob = (beta, z, b) => sig(feats(z, b).reduce((s, xi, i) => s + xi * beta[i], 0));

// Choose DS without touching the test seasons: fit on the seasons before the
// last fitting season, and score on that last one (the first high-scoring
// year), using the level a live app would have known then.
const VAL = TEST_FROM - 1;
const valFit = FINAL ? [] : rows(train.filter((m) => m.season < VAL), 2, fitLevel);
const valSet = FINAL ? [] : rows(train.filter((m) => m.season === VAL), 2, liveLevel);
const tried = [];
for (const ds of FIXED_DS != null || FINAL ? [] : [0, 0.25, 0.5, 0.75, 1]) {
  DS = ds;
  const beta = fitLogistic(valFit, (r) => zChase(r.st, r.m.target, r.L));
  let ll = 0;
  for (const r of valSet) { const p = Math.min(1 - 1e-6, Math.max(1e-6, prob(beta, zChase(r.st, r.m.target, r.L), r.st.b))); ll -= r.y * Math.log(p) + (1 - r.y) * Math.log(1 - p); }
  tried.push([ds, ll / valSet.length]);
}
tried.sort((a, b) => a[1] - b[1]);
DS = FIXED_DS != null ? FIXED_DS : tried.length ? tried[0][0] : 0.5;
console.log(`death overs follow ${DS * 100}% of the change in level${tried.length ? ` (chosen on ${VAL}: ${tried.map(([d, l]) => `${d}:${l.toFixed(4)}`).join(' ')})` : ''}`);

const chaseTrain = rows(train, 2, fitLevel);
const firstTrain = rows(train, 1, fitLevel);
const CHASE = fitLogistic(chaseTrain, (r) => zChase(r.st, r.m.target, r.L));
const FIRST = fitLogistic(firstTrain, (r) => zFirst(r.st, r.L));

const model = { L0, DEATH, DS, K, F: F_W, S: [S1, SP], CHASE, FIRST, levels: Object.fromEntries(seasons.map((s) => [s, Math.round(level[s].avg)])) };
console.log('\nfitted model:\n' + JSON.stringify(model));

if (FINAL) process.exit(0);

// ---------- 4. test: new model vs the original hand-tuned one ----------
const newChase = (st, target, L) => prob(CHASE, zChase(st, target, L), st.b);
const newFirst = (st, L) => prob(FIRST, zFirst(st, L), st.b);
// The original model, kept here to compare against.
const OLD_F = [0, 0.45, 0.58, 0.68, 0.77, 0.84, 0.9, 0.94, 0.97, 0.99, 1.0];
function oldPhi(z) { const t = 1 / (1 + 0.2316419 * Math.abs(z)); const d = 0.3989423 * Math.exp((-z * z) / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; }
const oldExp = (b, w) => (b / 6) * 8.5 * OLD_F[Math.max(0, Math.min(10, w))];
const oldSd = (b) => (b > 0 ? 1.25 * Math.sqrt(b) + 2 : 0);
const oldChase = (st, target) => { const need = target - st.r; if (need <= 0) return 1; if (st.b <= 0 || st.w <= 0) return 0; return oldPhi((oldExp(st.b, st.w) - need + 0.5) / oldSd(st.b)); };
const oldFirst = (st) => { const proj = st.r + oldExp(st.b, st.w); const sd = Math.sqrt(oldSd(120) ** 2 + oldSd(st.b) ** 2); return oldPhi((oldExp(120, 10) - proj - 1 + 0.5) / sd); };

function score(data, pOf) {
  let ll = 0, brier = 0;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
  for (const r of data) {
    const p = Math.min(1 - 1e-6, Math.max(1e-6, pOf(r)));
    ll -= r.y * Math.log(p) + (1 - r.y) * Math.log(1 - p);
    brier += (p - r.y) ** 2;
    const k = Math.min(9, Math.floor(p * 10)); bins[k].n++; bins[k].p += p; bins[k].y += r.y;
  }
  return { ll: ll / data.length, brier: brier / data.length, bins };
}
function report(title, data, models) {
  console.log(`\n${title} (${data.length} states)`);
  const res = models.map(([name, f]) => [name, score(data, f)]);
  for (const [name, s] of res) console.log(`  ${name.padEnd(9)} log loss ${s.ll.toFixed(4)}   Brier ${s.brier.toFixed(4)}`);
  console.log('  said      ' + res.map(([name]) => name.padEnd(22)).join(''));
  for (let k = 0; k < 10; k++) {
    console.log(`  ${String(k * 10).padStart(2)}-${String(k * 10 + 10).padStart(3)}%  ` + res.map(([, s]) => {
      const b = s.bins[k];
      return (b.n ? `won ${(100 * b.y / b.n).toFixed(0).padStart(3)}% of ${String(b.n).padStart(5)}` : '        -        ').padEnd(22);
    }).join(''));
  }
}
const chaseTest = rows(test, 2, liveLevel);
const firstTest = rows(test, 1, liveLevel);
report(`Chase, seasons ${TEST_FROM}+ (never seen while fitting)`, chaseTest, [['original', (r) => oldChase(r.st, r.m.target)], ['fitted', (r) => newChase(r.st, r.m.target, r.L)]]);
report(`First innings, seasons ${TEST_FROM}+`, firstTest, [['original', (r) => oldFirst(r.st)], ['fitted', (r) => newFirst(r.st, r.L)]]);
const lateTest = chaseTest.filter((r) => r.st.b <= 36);
report('Chase, last 6 overs only', lateTest, [['original', (r) => oldChase(r.st, r.m.target)], ['fitted', (r) => newChase(r.st, r.m.target, r.L)]]);

// The moment that started this: 62 needed off 30 with 6 wickets in hand.
const L19 = level[2019].avg;
const st = { b: 30, w: 6, r: 88 };
console.log(`\n62 off 30, 6 wickets in hand (2019 level ${L19.toFixed(0)}): original ${(100 * oldChase(st, 150)).toFixed(1)}%, fitted ${(100 * newChase(st, 150, L19)).toFixed(1)}%`);
let n = 0, won = 0;
for (const m of matches) for (const s of m.inns[1].states) {
  const need = m.target - s.r;
  if (s.b >= 27 && s.b <= 33 && s.w >= 5 && s.w <= 7 && need >= 55 && need <= 69) { n++; won += m.chaseWon ? 1 : 0; break; }
}
console.log(`real IPL chases needing 55-69 off 27-33 with 5-7 wickets in hand: won ${won} of ${n}`);

