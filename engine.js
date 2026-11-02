/* Dip In engine: the maths behind the companion (win chance, tension, alerts,
   catch-up facts and the built-in narrator), fed one ball at a time.

   Where balls come from is a separate question. The simulator at the bottom
   is one source; a live feed or a recorded real match is another. Every
   source hands the engine the same raw balls through createMatch and addBall,
   so the app works the same whatever is playing.

   Pure functions with no DOM, so Node can load it for tuning and checks. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DipEngine = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /* ---------- what a source passes in ----------

     createMatch(info), once, before the first ball:
       teams      { [id]: { id, name, short, players: [{ id, name, short?, wk?, bowl? }] } }
                  bowl is { type: 'pace'|'spin', skill?, death? } for bowlers, if known
       batFirst   id of the team batting first
       venue, par (typical first-innings score here), dateLabel,
       start      minutes after midnight of the first ball, e.g. 19 * 60 + 30
       overs      20 (only T20 is modelled)
       simulated  true for the made-up demo match

     addBall(match, ball), for every delivery in order, wides and no-balls included:
       inn        1 or 2
       over       over number, counting from 0
       striker, nonStriker, bowler   player ids
       runs       runs off the bat
       extras     extra runs on this ball, default 0
       extra      null, 'wd', 'nb', 'b' or 'lb'
       wicket     null or { kind, out, fielder?, how? }
                  kind: caught, bowled, lbw, stumped, runout, hitwicket, retired, other
       t          minutes since the first ball (optional, estimated if missing)
       text       commentary line (optional, a plain one is written if missing)
       next       { s, ns }: who is on strike and at the other end after this
                  ball (optional; worked out from the runs, and corrected when
                  the next ball arrives)

     The engine works out everything else: score, overs, labels, free hits,
     when an innings or the match ends, win chance, tension and alerts. */

  const BALLS = 120;  // T20

  // ---------- win chance ----------
  /* Fitted by tools/calibrate.js on 1,195 IPL matches (2008-2026) from
     Cricsheet. In the spirit of the DLS resource table, the runs still to come
     from b balls with w wickets in hand are L0 x R(b, w) x M(b, L), spread
     L0 x S(b, w) x M(b, L). L is the scoring level, the typical first-innings
     total: IPL went from about 163 to 196, nearly all of it before the last
     five overs, so M scales the death overs by only half the change. A
     logistic step on top turns that into a calibrated chance. Tested on the
     2024-2026 seasons it never saw, chase log loss fell from 1.01 to 0.37. */
  const MODEL = {
    L0: 163, DEATH: 30, DS: 0.5, K: 0.0132,
    F: [0.0477, 0.1, 0.2021, 0.3498, 0.4657, 0.6822, 0.9192, 1.1259, 1.3626, 1.5723], // by wickets in hand, 1 to 10
    S: [0.1754, 0.6276],
    CHASE: [0.2087, 1.0713, 0.2746, 0.5262],
    FIRST: [0.2022, 1.2593, 0.0574, -0.1079],
  };
  const LEVEL = 196; // IPL 2026 average first-innings total, for feeds that give no level
  const levelOf = (match) => match.info.scoring || match.info.par || LEVEL;

  function share(b, wih) {
    if (b <= 0 || wih <= 0) return 0;
    const F = MODEL.F[Math.min(10, wih) - 1];
    return F * (1 - Math.exp(-MODEL.K * b / F));
  }
  // How much more (or less) is still to come at level L than at L0.
  function levelScale(b, L) {
    const r0 = share(b, 10);
    if (r0 <= 0) return 1;
    const full = share(BALLS, 10);
    const death = share(MODEL.DEATH, 10);
    const d0 = share(Math.min(b, MODEL.DEATH), 10);
    const rho = L / MODEL.L0;
    const md = 1 + MODEL.DS * (rho - 1);
    const m = (full * rho - death * md) / (full - death);
    return (d0 * md + (r0 - d0) * m) / r0;
  }
  const expRuns = (b, wih, L) => MODEL.L0 * share(b, wih) * levelScale(b, L);
  const sdRuns = (b, wih, L) => MODEL.L0 * MODEL.S[0] * Math.pow(share(b, wih), MODEL.S[1]) * levelScale(b, L);
  function calibrated(beta, z, b) {
    const t = 1 - b / BALLS;
    return 1 / (1 + Math.exp(-(beta[0] + beta[1] * z + beta[2] * t + beta[3] * z * t)));
  }

  // Chance the chasing side scores `need` more runs from `b` balls with `wih` wickets left.
  function chaseChance(need, b, wih, L) {
    if (need <= 0) return 1;
    if (b <= 0 || wih <= 0) return 0;
    return calibrated(MODEL.CHASE, (expRuns(b, wih, L) - need + 0.5) / sdRuns(b, wih, L), b);
  }
  // Same question asked during the first innings, using the projected total.
  function firstInningsChase(total, b, wih, L) {
    if (b <= 0 || wih <= 0) return chaseChance(total + 1, BALLS, 10, L);
    const proj = total + expRuns(b, wih, L);
    const z = (expRuns(BALLS, 10, L) - proj - 0.5) / Math.sqrt(sdRuns(BALLS, 10, L) ** 2 + sdRuns(b, wih, L) ** 2);
    return calibrated(MODEL.FIRST, z, b);
  }
  function chaseWinChance(inn, total, wkts, legal, target, level) {
    const L = level || LEVEL;
    if (inn === 1) return firstInningsChase(total, BALLS - legal, 10 - wkts, L);
    return chaseChance(target - total, BALLS - legal, 10 - wkts, L);
  }

  // ---------- scorecards: rebuilt ball by ball ----------
  const BOWLER_CREDIT = new Set(['caught', 'bowled', 'lbw', 'stumped', 'hitwicket']);
  function newInnings(bat, bowl) {
    return {
      batTeam: bat, bowlTeam: bowl, total: 0, wkts: 0, legal: 0,
      bat: {}, batOrder: [], bowl: {}, bowlOrder: [], overs: [], fow: [],
      partnership: { runs: 0, balls: 0 }, next: null, lastBowler: null,
    };
  }
  function freshState(match) {
    return { idx: -1, inn: 1, innings: [newInnings(match.first, match.chase), newInnings(match.chase, match.first)] };
  }
  function batEntry(I, pid) {
    if (!I.bat[pid]) { I.bat[pid] = { pid, runs: 0, balls: 0, fours: 0, sixes: 0, out: null }; I.batOrder.push(pid); }
    return I.bat[pid];
  }
  function bowlEntry(I, pid) {
    if (!I.bowl[pid]) { I.bowl[pid] = { pid, balls: 0, runs: 0, wkts: 0, maidens: 0 }; I.bowlOrder.push(pid); }
    return I.bowl[pid];
  }
  function symbol(d) {
    if (d.wicket) return 'W';
    if (d.extra === 'wd') return d.extras > 1 ? `Wd${d.extras}` : 'Wd';
    if (d.extra === 'nb') return d.runs ? `Nb${d.runs}` : 'Nb';
    if (d.extra === 'b' || d.extra === 'lb') return `${d.extras}${d.extra}`;
    return d.runs === 0 ? '0' : String(d.runs);
  }
  function applyBall(st, d) {
    const I = st.innings[d.inn - 1];
    st.idx++; st.inn = d.inn;
    batEntry(I, d.striker); batEntry(I, d.nonStriker);
    const b = I.bat[d.striker];
    if (d.legal || d.extra === 'nb') b.balls++;
    b.runs += d.runs;
    if (d.runs === 4) b.fours++;
    if (d.runs === 6) b.sixes++;
    const bw = bowlEntry(I, d.bowler);
    bw.runs += d.runs + (d.extra === 'b' || d.extra === 'lb' ? 0 : d.extras);
    if (d.legal) bw.balls++;
    if (d.wicket && BOWLER_CREDIT.has(d.wicket.kind)) bw.wkts++;
    if (!I.overs[d.over]) I.overs[d.over] = { over: d.over, bowler: d.bowler, runs: 0, wkts: 0, balls: [] };
    const ov = I.overs[d.over];
    ov.runs += d.runs + d.extras;
    ov.balls.push(symbol(d));
    if (d.wicket) ov.wkts++;
    if (ov.balls.filter((s) => !s.startsWith('Wd') && !s.startsWith('Nb')).length === 6 && ov.runs === 0) bw.maidens++;
    I.partnership.runs += d.runs + d.extras;
    if (d.legal) I.partnership.balls++;
    if (d.wicket) {
      batEntry(I, d.wicket.out).out = d.wicket.how;
      I.fow.push({ wkt: d.wkts, score: d.total, label: d.label, pid: d.wicket.out, idx: st.idx });
      I.partnership = { runs: 0, balls: 0 };
    }
    I.total = d.total; I.wkts = d.wkts; I.legal = d.legalBalls;
    I.next = d.next; I.lastBowler = d.bowler;
  }

  const oversLabel = (legal) => `${Math.floor(legal / 6)}.${legal % 6}`;
  const figures = (bw) => `${oversLabel(bw.balls).replace(/\.0$/, '')}-${bw.maidens}-${bw.runs}-${bw.wkts}`;

  function clockLabel(t, start = 19 * 60 + 30) {
    const m = Math.round(start + t);
    let h = Math.floor(m / 60) % 24;
    const mm = String(m % 60).padStart(2, '0');
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${mm} ${ap}`;
  }

  function dismissal(P, w) {
    const b = P[w.bowler].short;
    const f = w.fielder ? P[w.fielder].short : '';
    switch (w.kind) {
      case 'caught': return w.fielder === w.bowler ? `c & b ${b}` : `c ${f} b ${b}`;
      case 'bowled': return `b ${b}`;
      case 'lbw': return `lbw b ${b}`;
      case 'stumped': return `st ${f} b ${b}`;
      case 'hitwicket': return `hit wicket b ${b}`;
      case 'retired': return 'retired';
      case 'runout': return f ? `run out (${f})` : 'run out';
      default: return 'out';
    }
  }

  // A plain snapshot of the match after ball `idx`: what the scoreboard shows.
  function snapshot(match, st) {
    const P = match.players;
    const T = match.info.teams;
    const d = match.balls[st.idx];
    const I = st.innings[d.inn - 1];
    const inningsOver = st.idx === match.innings[d.inn - 1].endIdx;
    const matchOver = !!match.result && st.idx === match.innings[1].endIdx;
    const s = {
      idx: st.idx, inn: d.inn, label: d.label, time: clockLabel(d.t, match.info.start), t: d.t,
      batTeam: I.batTeam, bowlTeam: I.bowlTeam,
      names: { bat: T[I.batTeam].short, bowl: T[I.bowlTeam].short, first: T[match.first].short, chase: T[match.chase].short, the: match.info.article !== false },
      total: I.total, wkts: I.wkts, legal: I.legal, overs: oversLabel(I.legal),
      crr: I.legal ? +(I.total / (I.legal / 6)).toFixed(2) : 0,
      inningsOver, matchOver, result: matchOver ? match.result.text : null,
      chaseWin: d.wp, tension: d.tension,
      partnership: I.partnership,
      par: match.info.par,
    };
    if (d.inn === 2) {
      s.target = match.target;
      s.need = Math.max(0, match.target - I.total);
      s.ballsLeft = BALLS - I.legal;
      s.rrr = s.ballsLeft ? +(s.need / (s.ballsLeft / 6)).toFixed(2) : null;
    } else {
      s.projected = Math.round(I.total + expRuns(BALLS - I.legal, 10 - I.wkts, levelOf(match)));
    }
    const crease = inningsOver ? [] : [I.next && I.next.s, I.next && I.next.ns].filter(Boolean);
    s.batters = crease.map((pid, i) => {
      const b = I.bat[pid] || { runs: 0, balls: 0, fours: 0, sixes: 0 };
      return { name: P[pid].name, short: P[pid].short, runs: b.runs, balls: b.balls, fours: b.fours, sixes: b.sixes, onStrike: i === 0 };
    });
    const bw = I.bowl[I.lastBowler];
    s.bowler = { name: P[I.lastBowler].name, short: P[I.lastBowler].short, figures: figures(bw) };
    const curOver = I.overs[d.over];
    s.thisOver = curOver ? curOver.balls.slice() : [];
    // Anyone listed as a bowler, plus anyone who has actually bowled.
    const quota = BALLS / 30;
    s.bowlersLeft = T[I.bowlTeam].players.map((p) => P[p.id]).filter((p) => p.bowl || I.bowl[p.id]).map((p) => {
      const e = I.bowl[p.id];
      const oversLeft = Math.max(0, quota - Math.ceil((e ? e.balls : 0) / 6));
      const k = p.bowl || {};
      return { name: p.name, short: p.short, oversLeft, figures: e ? figures(e) : '0-0-0-0', death: !!k.death, type: k.type || null, skill: k.skill,
        balls: e ? e.balls : 0, runs: e ? e.runs : 0, wkts: e ? e.wkts : 0 };
    });
    const lastFow = I.fow[I.fow.length - 1];
    s.lastWicket = lastFow ? { name: P[lastFow.pid].name, how: I.bat[lastFow.pid].out, runs: I.bat[lastFow.pid].runs, balls: I.bat[lastFow.pid].balls, score: `${lastFow.score}/${lastFow.wkt}`, label: lastFow.label } : null;
    s.topBatters = I.batOrder.map((pid) => I.bat[pid]).sort((a, b) => b.runs - a.runs).slice(0, 3)
      .map((b) => ({ name: P[b.pid].name, runs: b.runs, balls: b.balls, out: b.out }));
    s.topBowlers = I.bowlOrder.map((pid) => I.bowl[pid]).sort((a, b) => b.wkts - a.wkts || a.runs - b.runs).slice(0, 3)
      .map((b) => ({ name: P[b.pid].name, figures: figures(b) }));
    if (d.inn === 2) {
      const first = st.innings[0];
      s.firstInnings = { team: match.first, total: first.total, wkts: first.wkts, overs: oversLabel(first.legal) };
    }
    return s;
  }

  function stateAt(match, idx) {
    const st = freshState(match);
    for (let i = 0; i <= idx; i++) applyBall(st, match.balls[i]);
    return snapshot(match, st);
  }

  // ---------- tension & alerts ----------
  const TENSE = 70;
  function tensionOf(inn, total, wkts, legal, target, recentWicket, L) {
    const wp = chaseWinChance(inn, total, wkts, legal, target, L);
    if (inn === 2 && (total >= target || wkts >= 10 || legal >= BALLS)) return { wp, tension: 0 };
    const closeness = 1 - Math.abs(wp - 0.5) * 2;
    const progress = legal / BALLS;
    const stage = inn === 1 ? 0.25 + 0.35 * progress : 0.4 + 0.6 * progress;
    const six = chaseWinChance(inn, total + 6, wkts, legal + 1, target, L);
    const out = chaseWinChance(inn, total, Math.min(10, wkts + 1), legal + 1, target, L);
    const lev = Math.min(1, Math.abs(six - out) / 0.2);
    let tension = 100 * (0.5 * closeness * stage + 0.5 * lev * (0.4 + 0.6 * closeness) * stage);
    if (recentWicket) tension += 6;
    return { wp, tension: Math.max(0, Math.min(100, Math.round(tension))) };
  }

  function needLine(s) {
    return `need ${s.need} off ${s.ballsLeft}`;
  }
  function dangerBatter(s) {
    const set = s.batters.filter((b) => b.runs >= 25).sort((a, b) => b.runs - a.runs)[0];
    return set ? `${set.short} is set on ${set.runs}*` : null;
  }
  // A bowler's threat: the feed's rating if it has one, otherwise wickets and
  // economy so far.
  function rated(b) {
    if (b.skill != null) return b.skill;
    if (!b.balls || b.balls < 6) return 1;
    return 1 + 0.08 * b.wkts - 0.04 * (b.runs / (b.balls / 6) - 8);
  }
  function deathBowler(s) {
    if (s.inn !== 2 || s.ballsLeft <= 6) return null;
    const b = s.bowlersLeft.filter((x) => x.oversLeft > 0).sort((a, b) => rated(b) - rated(a))[0];
    return b ? `${b.short} has ${b.oversLeft} over${b.oversLeft === 1 ? '' : 's'} left` : null;
  }
  // Who is likely to bowl the last over: a death specialist with an over
  // left who did not bowl the one just finished. Without roles in the feed,
  // say nothing rather than guess.
  function lastOverBowler(s, justBowled) {
    return s.bowlersLeft.filter((b) => b.death && b.oversLeft > 0 && b.name !== justBowled)
      .sort((a, b) => rated(b) - rated(a))[0] || null;
  }
  // One plain sentence on why the meter reads what it does.
  function tensionReason(s) {
    const n = s.names;
    if (s.matchOver) return s.result + '.';
    if (s.inn === 1 && s.inningsOver) return `Innings break. ${n.chase} need ${s.total + 1} at ${((s.total + 1) / 20).toFixed(2)} an over.`;
    if (s.inn === 2) {
      const bits = [`${n.chase} ${needLine(s)}`, dangerBatter(s)];
      if (s.wkts >= 6) bits.push(`only ${10 - s.wkts} wickets left`);
      bits.push(deathBowler(s));
      return bits.filter(Boolean).join(', ') + '.';
    }
    return [`${n.first} ${s.total}/${s.wkts}, heading for about ${s.projected}${s.par ? ` (par ${s.par})` : ''}`, dangerBatter(s)].filter(Boolean).join(', ') + '.';
  }

  // Alert groups the fan can switch on or off.
  const ALERT_GROUP = { tense: 'tense', lastover: 'tense', bigwicket: 'wickets', collapse: 'wickets', bigover: 'overs', milestone: 'overs', innings: 'breaks', result: 'breaks' };
  const ordinal = (n) => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');

  // Win chance, tension and alerts for the newest ball. Runs once per ball as
  // it arrives; the running state lives in match.live.
  function annotateLast(match) {
    const L = match.live;
    const st = L.st;
    const i = st.idx;
    const d = match.balls[i];
    const P = match.players;
    L.before = { prevTension: L.prevTension, lastTenseIdx: L.lastTenseIdx, lastCollapseIdx: L.lastCollapseIdx };
    const I = st.innings[d.inn - 1];
    const recentWicket = d.wicket || (i > 0 && match.balls[i - 1].wicket && match.balls[i - 1].inn === d.inn);
    const { wp, tension } = tensionOf(d.inn, d.total, d.wkts, d.legalBalls, match.target, recentWicket, levelOf(match));
    d.wp = wp; d.tension = tension;
    d.alerts = [];
    const s = snapshot(match, st);
    const team = s.names.bat;
    const score = `${s.total}/${s.wkts} (${s.overs})`;

    if (d.wicket) {
      const e = I.bat[d.wicket.out];
      const p = P[d.wicket.out];
      if (e.runs >= 30) {
        d.alerts.push({ kind: 'bigwicket', title: `Big wicket: ${p.short} out for ${e.runs}`,
          body: `${p.name} ${d.wicket.how} ${e.runs} (${e.balls}). ${team} ${score}.` });
      }
      const recent = I.fow.filter((f) => st.idx - f.idx <= 14);
      if (recent.length >= 3 && i - L.lastCollapseIdx > 14) {
        const runsSince = d.total - recent[0].score + (match.balls[recent[0].idx].runs + match.balls[recent[0].idx].extras);
        d.alerts.push({ kind: 'collapse', title: `${team} wobble: ${recent.length} wickets in a few overs`,
          body: `${recent.length} down for ${runsSince} run${runsSince === 1 ? '' : 's'}. ${team} ${score}.` });
        L.lastCollapseIdx = i;
      }
    }
    const e = I.bat[d.striker];
    const before = e.runs - d.runs;
    for (const m of [50, 100]) {
      if (before < m && e.runs >= m) d.alerts.push({ kind: 'milestone', title: `${P[d.striker].short} reaches ${m}`, body: `${P[d.striker].name} ${e.runs}* off ${e.balls}. ${team} ${score}.` });
    }
    const overDone = d.legal && d.legalBalls % 6 === 0;
    if (overDone && I.overs[d.over].runs >= 18) {
      d.alerts.push({ kind: 'bigover', title: `${I.overs[d.over].runs} off the ${ordinal(d.over + 1)} over`,
        body: `${P[d.bowler].short} goes for ${I.overs[d.over].runs}. ${team} ${score}${d.inn === 2 ? `, ${needLine(s)}` : ''}.` });
    }
    // At most one "tune in" ping every three overs so it never nags,
    // unless the game is on a knife-edge.
    const gap = i - L.lastTenseIdx;
    if (tension >= TENSE && L.prevTension < TENSE && (gap >= 18 || (tension >= 85 && gap >= 9)) && !s.matchOver) {
      const bits = d.inn === 2
        ? [`${team} ${needLine(s)}`, dangerBatter(s), deathBowler(s)]
        : [`${team} ${score}`, dangerBatter(s), `heading for ${s.projected}${s.par ? ` (par here is ${s.par})` : ''}`];
      d.alerts.push({ kind: 'tense', title: tension >= 85 ? 'Get to a screen now' : 'Worth watching now', body: bits.filter(Boolean).join(', ') + '.' });
      L.lastTenseIdx = i;
    }
    if (d.inn === 2 && overDone && d.legalBalls === BALLS - 6 && !s.matchOver && wp > 0.08 && wp < 0.92) {
      const last = lastOverBowler(s, P[d.bowler].name);
      d.alerts.push({ kind: 'lastover', title: `Last over: ${s.need} needed`, body: `${team} need ${s.need} off 6 with ${10 - s.wkts} wickets left.${last ? ` ${last.short} to bowl it.` : ''}` });
    }
    if (d.inn === 1 && s.inningsOver) {
      d.alerts.push({ kind: 'innings', title: `Innings break: ${s.names.chase} need ${match.target}`,
        body: `${s.names.first} finish on ${s.total}/${s.wkts}.${s.par ? ` Par here is about ${s.par}.` : ''} The chase starts in 20 minutes.` });
    }
    if (s.matchOver) {
      const [i1, i2] = match.innings;
      d.alerts.push({ kind: 'result', title: match.result.text, body: `Final: ${s.names.first} ${i1.total}/${i1.wkts}, ${s.names.chase} ${i2.total}/${i2.wkts} (${oversLabel(i2.legal)}).` });
    }
    for (const a of d.alerts) a.group = ALERT_GROUP[a.kind];
    L.prevTension = tension;
  }

  // ---------- building a match from a feed ----------
  function createMatch(info) {
    const ids = Object.keys(info.teams);
    const first = info.batFirst || ids[0];
    const chase = ids.find((id) => id !== first);
    const match = {
      info: Object.assign({ venue: '', par: null, start: 19 * 60 + 30, dateLabel: '', overs: 20, simulated: false }, info, { batFirst: first }),
      first, chase, players: {},
      balls: [],
      innings: [
        { inn: 1, bat: first, bowl: chase, total: 0, wkts: 0, legal: 0, startIdx: null, endIdx: null },
        { inn: 2, bat: chase, bowl: first, total: 0, wkts: 0, legal: 0, startIdx: null, endIdx: null },
      ],
      target: null, result: null,
    };
    for (const id of ids) for (const p of info.teams[id].players) addPlayer(match, id, p);
    match.live = { st: freshState(match), prevTension: 0, lastTenseIdx: -99, lastCollapseIdx: -99, guessed: -1 };
    return match;
  }

  // Register a player, e.g. an Impact Player substitute who was not in the XI.
  function addPlayer(match, teamId, p) {
    const parts = String(p.name || p.id).split(' ');
    match.players[p.id] = Object.assign({ name: p.id, short: parts[parts.length - 1] }, p, { team: teamId });
    const list = match.info.teams[teamId].players;
    if (!list.some((x) => x.id === p.id)) list.push(match.players[p.id]);
    return match.players[p.id];
  }

  // Who should be at the crease after a ball, from the runs alone. A dismissed
  // batter leaves a gap until the next ball says who walked out.
  function guessNext(d) {
    let s = d.striker;
    let ns = d.nonStriker;
    if (d.wicket && d.wicket.out === s) s = null;
    else if (d.wicket && d.wicket.out === ns) ns = null;
    const ran = d.runs + (d.extra === 'b' || d.extra === 'lb' ? d.extras : d.extra === 'wd' ? d.extras - 1 : 0);
    if (ran % 2 === 1) [s, ns] = [ns, s];
    if (d.legal && d.legalBalls % 6 === 0) [s, ns] = [ns, s];
    return { s, ns };
  }

  function plainText(P, d) {
    let say;
    if (d.wicket) say = `OUT, ${P[d.wicket.out].short} ${d.wicket.how}`;
    else if (d.extra === 'wd') say = d.extras > 1 ? `${d.extras} wides` : 'wide';
    else if (d.extra === 'nb') say = `no-ball${d.runs ? `, and ${d.runs} off the bat` : ''}`;
    else if (d.extra === 'b' || d.extra === 'lb') say = `${d.extras} ${d.extra === 'b' ? 'bye' : 'leg bye'}${d.extras === 1 ? '' : 's'}`;
    else if (d.runs === 4) say = 'FOUR';
    else if (d.runs === 6) say = 'SIX';
    else say = d.runs ? `${d.runs} run${d.runs === 1 ? '' : 's'}` : 'no run';
    return `${P[d.bowler].short} to ${P[d.striker].short}, ${say}`;
  }

  function resultOf(match) {
    const T = match.info.teams;
    const [, i2] = match.innings;
    const first = T[match.first].short;
    const chase = T[match.chase].short;
    if (i2.total >= match.target) {
      const w = 10 - i2.wkts;
      const b = BALLS - i2.legal;
      return { winner: match.chase, margin: `${w} wicket${w === 1 ? '' : 's'}`, ballsLeft: b,
        text: `${chase} win by ${w} wicket${w === 1 ? '' : 's'}${b ? ` with ${b} ball${b === 1 ? '' : 's'} left` : ' off the last ball'}` };
    }
    if (i2.total === match.target - 1) return { winner: null, text: 'Match tied' };
    const m = match.target - 1 - i2.total;
    return { winner: match.first, margin: `${m} run${m === 1 ? '' : 's'}`, text: `${first} win by ${m} run${m === 1 ? '' : 's'}` };
  }

  function endInnings(match, opts) {
    const meta = match.innings[match.live.st.inn - 1];
    if (meta.endIdx != null) return;
    meta.endIdx = match.balls.length - 1;
    if (meta.inn === 1) match.target = (opts && opts.target) || meta.total + 1;
    else match.result = (opts && opts.result) || resultOf(match);
  }

  // The engine closes an innings by itself at ten wickets, the last over, or
  // the target reached. A feed calls this for anything else (a shortened
  // innings, an abandoned match), optionally with { target } or { result }.
  function closeInnings(match, opts) {
    if (!match.balls.length) return;
    const L = match.live;
    endInnings(match, opts);
    Object.assign(L, L.before);
    annotateLast(match);
  }

  function addBall(match, raw) {
    if (match.result) throw new Error('the match is already over');
    const L = match.live;
    const inn = raw.inn;
    if (inn === 2 && match.innings[0].endIdx == null && match.balls.length) closeInnings(match);
    const meta = match.innings[inn - 1];
    if (meta.endIdx != null) throw new Error(`innings ${inn} is already over`);
    const prev = match.balls[match.balls.length - 1] || null;
    const same = prev && prev.inn === inn ? prev : null;
    const P = match.players;
    for (const [id, team] of [[raw.striker, meta.bat], [raw.nonStriker, meta.bat], [raw.bowler, meta.bowl]]) {
      if (!P[id]) addPlayer(match, team, { id });
    }

    const d = {
      inn, over: raw.over, striker: raw.striker, nonStriker: raw.nonStriker, bowler: raw.bowler,
      runs: raw.runs || 0, extras: raw.extras || 0, extra: raw.extra || null,
      legal: raw.extra !== 'wd' && raw.extra !== 'nb',
      wicket: null,
      freeHit: !!same && (same.extra === 'nb' || (same.extra === 'wd' && same.freeHit)),
    };
    if (raw.wicket) {
      const w = raw.wicket;
      if (w.fielder && !P[w.fielder]) addPlayer(match, meta.bowl, { id: w.fielder });
      d.wicket = { kind: w.kind, out: w.out, bowler: w.bowler || raw.bowler, fielder: w.fielder || null };
      d.wicket.how = w.how || dismissal(P, d.wicket);
    }
    d.total = (same ? same.total : 0) + d.runs + d.extras;
    d.wkts = (same ? same.wkts : 0) + (d.wicket && d.wicket.kind !== 'retired' ? 1 : 0);
    d.legalBalls = (same ? same.legalBalls : 0) + (d.legal ? 1 : 0);
    const inOver = (same ? same.legalBalls : 0) - 6 * d.over + (d.legal ? 1 : 0);
    d.label = raw.label || `${d.over}.${d.legal ? inOver : inOver + 1}`;
    d.t = raw.t != null ? raw.t : (prev ? prev.t : 0) + (d.legal ? 0.6 : 0.3) + (d.wicket ? 1 : 0);
    d.text = raw.text || plainText(P, d);
    d.next = raw.next ? { s: raw.next.s, ns: raw.next.ns } : guessNext(d);

    // This ball shows who really took strike after the last one.
    if (same && L.guessed === match.balls.length - 1) same.next = { s: d.striker, ns: d.nonStriker };
    L.guessed = raw.next ? -1 : match.balls.length;

    match.balls.push(d);
    if (meta.startIdx == null) meta.startIdx = match.balls.length - 1;
    applyBall(L.st, d);
    meta.total = d.total; meta.wkts = d.wkts; meta.legal = d.legalBalls;
    if (d.wkts >= 10 || d.legalBalls >= BALLS || (inn === 2 && d.total >= match.target)) endInnings(match);
    annotateLast(match);
    return d;
  }

  function tensionLabel(t) {
    if (t >= 75) return 'Edge of your seat';
    if (t >= 55) return 'Tense';
    if (t >= 30) return 'Simmering';
    return 'Quiet';
  }
  function verdictFor(t) {
    if (t >= TENSE) return 'watch_now';
    if (t >= 45) return 'worth_a_look';
    return 'relax';
  }

  // ---------- what happened between two balls ----------
  function windowFacts(match, from, to) {
    const P = match.players;
    const T = match.info.teams;
    const side = (inn) => T[inn === 1 ? match.first : match.chase].short;
    const then = from >= 0 ? stateAt(match, from) : null;
    const now = stateAt(match, to);
    const segments = [];
    const events = [];
    const st = freshState(match);
    for (let i = 0; i <= to; i++) {
      const d = match.balls[i];
      applyBall(st, d);
      if (i <= from) continue;
      let seg = segments[segments.length - 1];
      if (!seg || seg.inn !== d.inn) {
        const prev = i > 0 && match.balls[i - 1].inn === d.inn ? match.balls[i - 1] : null;
        seg = { inn: d.inn, team: side(d.inn), fromScore: prev ? `${prev.total}/${prev.wkts}` : '0/0', fromOvers: prev ? oversLabel(prev.legalBalls) : '0.0', runs: 0, wkts: 0, balls: 0, fours: 0, sixes: 0 };
        segments.push(seg);
      }
      seg.runs += d.runs + d.extras;
      if (d.legal) seg.balls++;
      if (d.wicket) seg.wkts++;
      if (d.runs === 4) seg.fours++;
      if (d.runs === 6) seg.sixes++;
      seg.toScore = `${d.total}/${d.wkts}`;
      seg.toOvers = oversLabel(d.legalBalls);
      const I = st.innings[d.inn - 1];
      if (d.wicket) {
        const e = I.bat[d.wicket.out];
        events.push({ idx: i, at: d.label, inn: d.inn, kind: 'wicket', who: P[d.wicket.out].short, runs: e.runs,
          text: `${P[d.wicket.out].name} ${d.wicket.how} ${e.runs} (${e.balls})`, weight: 2 + e.runs / 20, swing: Math.abs(d.wp - (i > 0 ? match.balls[i - 1].wp : 0.5)) });
      }
      for (const a of d.alerts) {
        if (a.kind === 'bigover' || a.kind === 'milestone') events.push({ idx: i, at: d.label, inn: d.inn, kind: a.kind, text: a.title, weight: a.kind === 'bigover' ? 2.5 : 2, swing: 0 });
        if (a.kind === 'innings') events.push({ idx: i, at: d.label, inn: d.inn, kind: 'innings', text: a.body, weight: 3, swing: 0 });
      }
    }
    const rank = (e) => e.weight + e.swing * 10;
    const top = events.slice().sort((a, b) => rank(b) - rank(a)).slice(0, 4)
      .sort((a, b) => (a.inn - b.inn) || (a.idx - b.idx));
    // The single moment that mattered most, and what happened after it.
    const biggest = events.filter((e) => e.kind !== 'innings').sort((a, b) => rank(b) - rank(a))[0] || null;
    if (biggest) {
      const d0 = match.balls[biggest.idx];
      let end = biggest.idx;
      while (end + 1 <= to && match.balls[end + 1].inn === d0.inn) end++;
      const d1 = match.balls[end];
      biggest.after = { team: side(d0.inn), runs: d1.total - d0.total, wkts: d1.wkts - d0.wkts, balls: d1.legalBalls - d0.legalBalls };
    }
    const wpThen = from >= 0 ? match.balls[from].wp : 0.5;
    const away = match.balls[to].t - (from >= 0 ? match.balls[from].t : 0);
    return {
      minutesAway: Math.round(away), ballsMissed: to - from,
      fromLabel: then ? `${T[then.batTeam].short} ${then.total}/${then.wkts} (${then.overs})` : 'before the first ball',
      segments, keyEvents: top, allEvents: events, biggest,
      // win chance of the chasing side, in percent
      chaseChance: { then: Math.round(wpThen * 100), now: Math.round(match.balls[to].wp * 100) },
      tension: now.tension, tensionLabel: tensionLabel(now.tension), verdict: verdictFor(now.tension),
      now,
    };
  }

  // ---------- built-in narrator (no AI) ----------
  function localCatchUp(f, lang) {
    const hi = lang === 'hinglish';
    const n = f.now;
    const { first, chase } = n.names;
    const the = n.names.the ? 'the ' : '';
    const segText = f.segments.map((s) => {
      if (hi) return `${s.team} ne ${s.balls} balls mein ${s.runs} run banaye, ${s.wkts} wicket gire (${s.fromScore} se ${s.toScore})`;
      return `${s.team} scored ${s.runs} for ${s.wkts} in ${s.balls} balls (${s.fromScore} to ${s.toScore})`;
    }).join(hi ? '; ' : ', then ');
    const swing = f.chaseChance.now - f.chaseChance.then;
    const leader = f.chaseChance.now >= 50 ? chase : first;
    const leaderPct = f.chaseChance.now >= 50 ? f.chaseChance.now : 100 - f.chaseChance.now;
    const riser = swing > 0 ? chase : first;
    let headline;
    if (n.matchOver) headline = n.result;
    else if (Math.abs(swing) >= 20) headline = hi ? `Match palat gaya, ${riser} ki taraf` : `The game swung towards ${the}${riser}`;
    else if (f.tension >= TENSE) headline = hi ? 'Match tight ho gaya hai' : "Game on: it's getting tight";
    else if (Math.abs(swing) >= 10) headline = hi ? `${riser} wapas aa rahe hain` : `${the ? 'The ' : ''}${riser} are fighting back`;
    else if (f.segments.reduce((a, s) => a + s.wkts, 0) >= 3) headline = hi ? 'Wickets gire, match khula hai' : 'Wickets fell while you were away';
    else headline = hi ? 'Zyada kuch nahi badla' : 'Steady going, not much changed';

    let moments = '';
    const big = f.biggest;
    if (big) {
      const a = big.after;
      const tail = a && a.balls >= 6
        ? (hi ? ` Uske baad ${a.team} ne ${a.balls} balls mein ${a.runs} run banaye, ${a.wkts} wicket gire.` : ` After that, ${the}${a.team} made ${a.runs} for ${a.wkts} in ${a.balls} balls.`)
        : '';
      if (big.kind === 'wicket') moments = (hi ? `Sabse bada moment: ${big.who} ${big.runs} pe out (${big.at}).` : `Biggest moment: ${big.who} out for ${big.runs} at ${big.at}.`) + tail;
      else moments = (hi ? `Sabse bada moment: ${big.text} (${big.at}).` : `Biggest moment: ${big.text} (${big.at}).`) + tail;
    }
    let nextLine;
    if (n.matchOver) nextLine = hi ? 'Match khatam. Highlights dekh lo.' : 'That is the match. Catch the highlights.';
    else if (n.inn === 2) {
      const db = deathBowler(n);
      nextLine = hi ? `Ab: ${chase} ko ${n.ballsLeft} balls mein ${n.need} chahiye.${db ? ` ${db.replace('has', 'ke paas').replace('left', 'bache hain')}.` : ''}`
        : `Now: ${chase} ${needLine(n)}.${db ? ` ${db}.` : ''}`;
    } else {
      nextLine = hi ? `Ab: ${first} ${n.total}/${n.wkts} (${n.overs}), ${n.projected} tak ja sakte hain${n.par ? ` (par ${n.par})` : ''}.`
        : `Now: ${first} ${n.total}/${n.wkts} (${n.overs}), on track for about ${n.projected}${n.par ? ` against a par of ${n.par}` : ''}.`;
    }
    const lines = [
      (hi ? 'Aap ke jaane ke baad: ' : 'While you were away, ') + segText + '.',
      moments || (hi ? 'Koi bada moment nahi hua.' : 'No big moments, just steady cricket.'),
      nextLine,
    ];
    let reason;
    if (n.matchOver) reason = hi ? 'Match khatam ho gaya.' : 'The match is over.';
    else reason = hi
      ? `${leader} ke jeetne ke chances ${leaderPct}%. Tension: ${f.tensionLabel}.`
      : `${leader} ${leaderPct}% to win. Tension: ${f.tensionLabel.toLowerCase()}.`;
    return { headline, lines, verdict: n.matchOver ? 'relax' : f.verdict, verdict_reason: reason };
  }

  // Short answers for the suggested questions when live AI is off.
  function localAnswer(q, s) {
    const t = q.toLowerCase();
    const team = s.names.bat;
    if (/free hit/.test(t)) return 'A free hit comes after a no-ball. On that ball the batter cannot be out bowled, caught, lbw or stumped, only run out, so they swing hard.';
    if (/dls|rain|duckworth/.test(t)) return 'DLS sets a fair target when rain cuts overs. It looks at how many overs and wickets each side had left, not just runs, so a side with wickets in hand gets a tougher target.';
    if (/impact/.test(t)) return 'The Impact Player rule lets each side swap one player mid-match for a named substitute, usually a batter in for a bowler or the other way round.';
    if (s.matchOver) return `${s.result}.`;
    if (/need|target|chase/.test(t) && s.inn === 2) return `${team} ${needLine(s)} at ${s.rrr} an over. They are scoring at ${s.crr}.`;
    if (/good score|par|enough/.test(t)) {
      if (!s.par) return s.inn === 1 ? `${s.names.first} are heading for about ${s.projected}. I don't have a par score for this ground.` : `${s.names.first} made ${s.firstInnings.total}. I don't have a par score for this ground.`;
      return s.inn === 1
        ? `Par here is about ${s.par}. ${s.names.first} are heading for ${s.projected}, so that would be ${s.projected >= s.par ? 'above' : 'below'} par.`
        : `${s.names.first} made ${s.firstInnings.total}, against a par of about ${s.par} here.`;
    }
    if (/danger|who|best/.test(t)) {
      const bat = s.batters.slice().sort((a, b) => b.runs - a.runs)[0];
      const bowl = s.topBowlers[0];
      return `${bat ? `${bat.name} (${bat.runs}* off ${bat.balls}) is the batter to watch. ` : ''}${bowl ? `Best bowler so far: ${bowl.name}, ${bowl.figures}.` : ''}`;
    }
    if (/win|chance/.test(t)) {
      const p = Math.round(s.chaseWin * 100);
      return `${s.names.chase} ${p}%, ${s.names.first} ${100 - p}% to win right now.`;
    }
    if (/tension|tense/.test(t)) return `Tension is ${s.tension}/100 (${tensionLabel(s.tension).toLowerCase()}). It rises when the result is close and one ball could swing it.`;
    return null;
  }

  /* ---------- a source: the simulated demo match ----------
     Makes up a whole T20 between two fictional sides and hands it over as raw
     balls, exactly as a live feed would. The ratings below only steer the
     dice; the engine above never reads them, apart from bowler skill, which a
     real feed can leave out. */
  const SEED = 1842;               // picked by tools/pick-seed.js: a one-run finish with three well-spaced pings
  const SIM = { venue: 'Riverside Ground, Nashik', par: 170, start: 19 * 60 + 30, dateLabel: 'Monday, 2 November' };

  function rngFrom(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
  function weighted(rng, pairs) {
    let r = rng();
    for (const [v, w] of pairs) { if ((r -= w) <= 0) return v; }
    return pairs[pairs.length - 1][0];
  }

  function player(id, name, bat, extra) {
    const parts = name.split(' ');
    return Object.assign({ id, name, short: parts[parts.length - 1], bat }, extra);
  }
  // Bowler for each over, as an index into the fielding XI: new-ball pair up
  // front, spin through the middle, the death specialist at 17 and 20.
  const PLAN = [8, 6, 9, 6, 8, 9, 7, 10, 7, 10, 5, 7, 10, 6, 7, 9, 8, 6, 9, 8];

  const TEAMS = {
    KT: {
      id: 'KT', name: 'Konkan Tides', short: 'Tides',
      players: [
        player('kt1', 'Arjun Malvankar', 1.1),
        player('kt2', 'Dev Sawant', 1.0),
        player('kt3', 'Kieran Lowe', 1.2, { overseas: true }),
        player('kt4', 'Rohan Desai', 1.05, { captain: true }),
        player('kt5', 'Imran Patel', 1.0, { wk: true }),
        player('kt6', 'Sid Naik', 0.95, { bowl: { type: 'spin', skill: 0.92 } }),
        player('kt7', 'Marco Botha', 1.0, { overseas: true, bowl: { type: 'pace', skill: 1.04 } }),
        player('kt8', 'Tejas Gawde', 0.62, { bowl: { type: 'spin', skill: 1.06 } }),
        player('kt9', 'Aniket More', 0.5, { bowl: { type: 'pace', skill: 1.12, death: true } }),
        player('kt10', 'Pranav Kulkarni', 0.45, { bowl: { type: 'pace', skill: 0.96 } }),
        player('kt11', 'Yash Rane', 0.4, { bowl: { type: 'spin', skill: 1.0 } }),
      ],
    },
    DF: {
      id: 'DF', name: 'Deccan Falcons', short: 'Falcons',
      players: [
        player('df1', 'Vikram Reddy', 1.1),
        player('df2', 'Faiz Qureshi', 1.0),
        player('df3', 'Aditya Rao', 1.15, { captain: true }),
        player('df4', 'Liam Carter', 1.22, { overseas: true }),
        player('df5', 'Karthik Iyer', 1.0, { wk: true }),
        player('df6', 'Nikhil Varma', 0.98, { bowl: { type: 'spin', skill: 0.9 } }),
        player('df7', 'Tom Whitfield', 0.85, { overseas: true, bowl: { type: 'pace', skill: 1.02 } }),
        player('df8', 'Harsh Bhatt', 0.6, { bowl: { type: 'spin', skill: 1.05 } }),
        player('df9', 'Sameer Khan', 0.5, { bowl: { type: 'pace', skill: 1.14, death: true } }),
        player('df10', 'Ravi Gowda', 0.45, { bowl: { type: 'pace', skill: 0.97 } }),
        player('df11', 'Ankit Joshi', 0.4, { bowl: { type: 'spin', skill: 1.0 } }),
      ],
    },
  };
  const PLAYERS = {};
  for (const t of Object.values(TEAMS)) for (const p of t.players) { p.team = t.id; PLAYERS[p.id] = p; }

  const OUTCOMES = [0, 1, 2, 3, 4, 6, 'W'];
  const BASE = {
    pp:    [0.40, 0.30, 0.06, 0.010, 0.145, 0.045, 0.040],
    mid:   [0.33, 0.41, 0.08, 0.005, 0.090, 0.045, 0.040],
    death: [0.29, 0.32, 0.08, 0.005, 0.120, 0.100, 0.085],
  };

  function outcomeProbs(phase, batter, bowl, ctx) {
    const p = BASE[phase].slice();
    let boundary = batter.bat / bowl.skill;
    let wicket = bowl.skill / Math.max(0.4, batter.bat);
    if (ctx.faced < 5) { boundary *= 0.8; wicket *= 1.2; }
    else if (ctx.faced > 15) { boundary *= 1.15; wicket *= 0.85; }
    if (ctx.rrr != null) {
      if (ctx.rrr > 12) { boundary *= 1.25; wicket *= 1.45; }
      else if (ctx.rrr > 9.5) { boundary *= 1.1; wicket *= 1.15; }
      else if (ctx.rrr < 6) { boundary *= 0.85; wicket *= 0.75; }
    }
    if (ctx.wktsDown >= 6 && phase !== 'death') { boundary *= 0.85; wicket *= 0.9; }
    if (bowl.type === 'spin' && phase === 'death') boundary *= 1.1;
    if (ctx.freeHit) boundary *= 1.5;
    p[4] *= boundary; p[5] *= boundary; p[6] *= wicket;
    const fixed = p[2] + p[3] + p[4] + p[5] + p[6];
    const rest = Math.max(0.05, 1 - fixed);
    const ds = p[0] + p[1];
    p[0] = (p[0] / ds) * rest;
    p[1] = (p[1] / ds) * rest;
    return p;
  }

  const SAY = {
    0: ['no run, beaten outside off', 'defended back down the pitch', 'no run, straight to cover', 'dot ball, good length and left alone', 'no run, swing and a miss'],
    1: ['1 run, worked to square leg', '1 run, pushed to long-on', '1 run, dabbed to third man', '1 run, nudged into the leg side'],
    2: ['2 runs, driven into the gap and they come back for two', '2 runs, flicked off the pads to deep square'],
    3: ['3 runs, chased down just inside the rope'],
    4: ['FOUR, cracked through extra cover', 'FOUR, pulled hard, one bounce over midwicket', 'FOUR, thick edge flies past slip', 'FOUR, lofted over mid-off', 'FOUR, cut fiercely past point'],
    6: ['SIX, launched over long-on', 'SIX, slog-swept into the crowd', 'SIX, flat and hard over midwicket', 'SIX, upper-cut over third man', 'SIX, straight back over the bowler'],
    wd: ['wide, sprayed down the leg side', 'wide, too far outside off'],
  };
  const KINDS = {
    spin: [['caught', 0.52], ['bowled', 0.16], ['lbw', 0.16], ['stumped', 0.08], ['runout', 0.08]],
    pace: [['caught', 0.62], ['bowled', 0.18], ['lbw', 0.12], ['runout', 0.08]],
  };

  function wicketLine(w, rng) {
    const f = w.fielder ? PLAYERS[w.fielder].short : '';
    switch (w.kind) {
      case 'caught':
        if (w.fielder === w.bowler) return 'OUT, caught and bowled, a sharp return catch';
        if (PLAYERS[w.fielder].wk) return `OUT, edged and taken by ${f} behind the stumps`;
        return pick(rng, [`OUT, caught by ${f} in the deep`, `OUT, skied and ${f} holds on`, `OUT, mistimed straight to ${f}`]);
      case 'bowled': return pick(rng, ['OUT, bowled, through the gate', 'OUT, bowled, the stumps are rattled']);
      case 'lbw': return 'OUT, lbw, trapped right in front';
      case 'stumped': return `OUT, stumped by ${f}, beaten in the flight`;
      default: return `OUT, run out, direct hit from ${f}`;
    }
  }

  // Plays one innings and appends its raw balls. Returns the score, which the
  // simulator needs to set the second innings' target.
  function playInnings(rng, bat, bowl, inn, target, balls, clock) {
    const xi = bat.players;
    let striker = 0, nonStriker = 1, nextIn = 2;
    const faced = new Array(11).fill(0);
    let total = 0, wkts = 0, legal = 0, freeHit = false, done = false;
    const atCrease = () => ({
      s: striker < 11 ? xi[striker].id : null,
      ns: nonStriker < 11 ? xi[nonStriker].id : null,
    });

    for (let over = 0; over < 20 && !done; over++) {
      const bowler = bowl.players[PLAN[over]];
      let inOver = 0;
      while (inOver < 6) {
        if (wkts === 10 || (target && total >= target)) { done = true; break; }
        const phase = over < 6 ? 'pp' : over < 15 ? 'mid' : 'death';
        const rrr = target ? (target - total) / ((120 - legal) / 6) : null;
        const sName = xi[striker].short;
        const d = {
          inn, over, striker: xi[striker].id, nonStriker: xi[nonStriker].id, bowler: bowler.id,
          runs: 0, extras: 0, extra: null, wicket: null,
        };
        let isLegal = true;
        const r = rng();
        let say;
        if (r < 0.033) {
          d.extra = 'wd'; d.extras = 1; isLegal = false;
          say = pick(rng, SAY.wd);
        } else if (r < 0.04) {
          d.extra = 'nb'; d.extras = 1; isLegal = false;
          d.runs = pick(rng, [0, 0, 0, 1, 1, 1, 2, 4, 4, 6]);
          say = `no-ball${d.runs ? `, and ${d.runs} off the bat` : ''}. Free hit next ball`;
        } else {
          const probs = outcomeProbs(phase, xi[striker], bowler.bowl, { faced: faced[striker], rrr, wktsDown: wkts, freeHit });
          const o = weighted(rng, OUTCOMES.map((v, i) => [v, probs[i]]));
          if (o === 'W' && freeHit) {
            say = 'free hit, caught, but it does not count. No run';
          } else if (o === 'W') {
            const kind = weighted(rng, KINDS[bowler.bowl.type]);
            let outIx = striker;
            if (kind === 'runout' && rng() < 0.4) outIx = nonStriker;
            const fielders = bowl.players.filter((p) => p.id !== bowler.id);
            const keeper = bowl.players.find((p) => p.wk);
            let fielder = null;
            if (kind === 'caught') {
              const c = rng();
              fielder = c < 0.18 ? keeper : c < 0.26 ? bowler : pick(rng, fielders.filter((p) => !p.wk));
            } else if (kind === 'stumped') fielder = keeper;
            else if (kind === 'runout') fielder = pick(rng, fielders);
            d.wicket = { kind, out: xi[outIx].id, bowler: bowler.id, fielder: fielder && fielder.id };
            say = wicketLine(d.wicket, rng);
            if (outIx === nonStriker) say += ` (${xi[nonStriker].short} is out)`;
            wkts++;
            if (outIx === striker) striker = nextIn++; else nonStriker = nextIn++;
          } else {
            d.runs = o;
            say = pick(rng, SAY[o]);
          }
        }
        d.text = `${bowler.short} to ${sName}, ${say}`;

        total += d.runs + d.extras;
        if (isLegal) { legal++; inOver++; }
        if (isLegal || d.extra === 'nb') faced[xi.indexOf(PLAYERS[d.striker])]++;
        if (d.extra === 'nb') freeHit = true;
        else if (d.extra !== 'wd') freeHit = false;
        if (d.runs % 2 === 1) [striker, nonStriker] = [nonStriker, striker];

        clock.t += isLegal ? 0.6 : 0.3;
        if (d.wicket) clock.t += 1.0;
        d.t = clock.t;
        d.next = atCrease();
        balls.push(d);
        if (target && total >= target) { done = true; break; }
        if (wkts === 10) { done = true; break; }
      }
      if (!done && inOver === 6) {
        [striker, nonStriker] = [nonStriker, striker];
        balls[balls.length - 1].next = atCrease();
        clock.t += 0.5;
      }
    }
    return total;
  }

  // The demo match as a feed: match info plus every raw ball, in order.
  function simulateFeed(seed) {
    const rng = rngFrom(seed);
    const balls = [];
    const clock = { t: 0 };
    const first = playInnings(rng, TEAMS.KT, TEAMS.DF, 1, null, balls, clock);
    clock.t += 20; // innings break
    playInnings(rng, TEAMS.DF, TEAMS.KT, 2, first + 1, balls, clock);
    const info = Object.assign({ id: `sim-${seed}`, overs: 20, simulated: true, badge: 'Simulated match', batFirst: 'KT', teams: TEAMS }, SIM);
    return { info: JSON.parse(JSON.stringify(info)), balls };
  }

  function simulateMatch(seed) {
    const feed = simulateFeed(seed);
    const match = createMatch(feed.info);
    for (const ball of feed.balls) addBall(match, ball);
    match.seed = seed;
    return match;
  }

  return {
    SEED,
    createMatch, addBall, addPlayer, closeInnings,
    simulateFeed, simulateMatch,
    stateAt, windowFacts, localCatchUp, localAnswer, tensionReason,
    chaseWinChance, tensionLabel, verdictFor, oversLabel, clockLabel, symbol, TENSE,
  };
});
