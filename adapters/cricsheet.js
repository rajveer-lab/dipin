/* Cricsheet adapter: turns a Cricsheet match file (cricsheet.org, JSON
   format) into a Dip In feed, { info, balls, items }, ready for the engine's
   createMatch and push. `balls` is every delivery; `items` is the same in
   order with the scoreboard's status messages added: rain limits and revised
   targets, and the result when the engine cannot work it out (DLS, a super
   over, no result). Cricsheet match data is free under the Open Data Commons
   Attribution License, so anything that shows it credits Cricsheet; the
   credit travels with the feed as info.credit.

   Cricsheet has no clock times, so ball times are estimated at the same
   pace the simulator uses. It also does not say when rain changed a target,
   only what the target ended up as, so a revised chase is set at its start. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DipCricsheet = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const KIND = {
    caught: 'caught', 'caught and bowled': 'caught', bowled: 'bowled', lbw: 'lbw', stumped: 'stumped',
    'run out': 'runout', 'hit wicket': 'hitwicket', 'retired hurt': 'retired', 'retired not out': 'retired',
  };
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  // "Mumbai Indians" -> "MI"
  const initials = (name) => name.split(/\s+/).map((w) => w[0]).join('').toUpperCase();
  // Short ids for the two sides: "MI", "CSK", "IND" for one-word names, and
  // longer when both would be the same ("Sussex" v "Surrey", "CV" v "CV").
  function teamIds(names) {
    const code = (n) => (/\s/.test(n) ? initials(n) : n.slice(0, 3).toUpperCase());
    const longer = (n) => { const [w, ...rest] = n.split(/\s+/); return w.slice(0, 3).toUpperCase() + initials(rest.join(' ') || ''); };
    let ids = names.map(code);
    if (ids[0] === ids[1]) ids = names.map(longer);
    if (ids[0] === ids[1]) ids = ids.map((id, i) => id + (i + 1));
    return Object.fromEntries(names.map((n, i) => [n, ids[i]]));
  }
  const runsLabel = (by) => (by.runs ? `${by.runs} run${by.runs === 1 ? '' : 's'}` : by.wickets ? `${by.wickets} wicket${by.wickets === 1 ? '' : 's'}` : '');
  const ballsLabel = (b) => (b % 6 ? `${Math.floor(b / 6)}.${b % 6}` : String(b / 6));
  const isLegal = (dl) => !(dl.extras && (dl.extras.wides || dl.extras.noballs));
  const counts = (w) => !/retired hurt|retired not out/.test(w.kind);
  // Cricsheet names lead with initials: "RG Sharma" -> "Sharma",
  // "Q de Kock" -> "de Kock", "Harbhajan Singh" stays as it is.
  function surname(name) {
    const parts = name.split(/\s+/);
    while (parts.length > 1 && /^[A-Z]{1,4}$/.test(parts[0])) parts.shift();
    return parts.join(' ');
  }
  function dateLabel(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return `${DAYS[day]}, ${d} ${MONTHS[m - 1]} ${y}`;
  }

  // opts: { id, event, short: { [team name]: label }, par, scoring, levels, start }
  //   scoring: typical first-innings total in that season, for the win model;
  //   without it, looked up in `levels` (data/levels.js) by competition
  function toFeed(cs, opts) {
    const o = opts || {};
    const ci = cs.info;
    if (ci.match_type !== 'T20' && ci.match_type !== 'IT20') throw new Error(`Dip In models T20 only, not ${ci.match_type}`);
    const inns = cs.innings.filter((x) => !x.super_over && x.overs).slice(0, 2);
    if (!inns.length) throw new Error('no innings in this match file');

    const ids = teamIds(ci.teams);
    const teams = {};
    for (const name of ci.teams) {
      const id = ids[name];
      teams[id] = {
        id, name, short: (o.short && o.short[name]) || id,
        players: (ci.players[name] || []).map((p) => ({ id: p, name: p, short: surname(p) })),
      };
    }
    const rival = (name) => ci.teams.find((t) => t !== name);
    // Two players with one surname (KH and HH Pandya) keep their initials.
    const seen = {};
    for (const name of ci.teams) for (const p of ci.players[name] || []) seen[surname(p)] = (seen[surname(p)] || 0) + 1;
    const shortOf = (p) => (seen[surname(p)] > 1 ? p : surname(p));
    for (const t of Object.values(teams)) for (const p of t.players) p.short = shortOf(p.id);
    // Substitute fielders and anyone else missing from the XI lists.
    const ensure = (team, p) => {
      const list = teams[ids[team]].players;
      if (!list.some((x) => x.id === p)) list.push({ id: p, name: p, short: shortOf(p) });
    };

    const full = (ci.overs || 20) * 6;
    const legalIn = (inn) => inn.overs.reduce((a, ov) => a + Math.min(6, ov.deliveries.filter(isLegal).length), 0);
    const wktsIn = (inn) => inn.overs.reduce((a, ov) => a + ov.deliveries.reduce((x, dl) => x + (dl.wickets || []).filter(counts).length, 0), 0);
    // Rain. A first innings that stopped short of its overs without being
    // bowled out had fewer overs: from the start if the chase got the same
    // number (a match cut before it began), else from where it stopped.
    const chaseTarget = inns[1] && inns[1].target;
    const firstBalls = legalIn(inns[0]);
    const firstCut = firstBalls < full && wktsIn(inns[0]) < 10 && inns.length === 2;
    const cutFromStart = firstCut && chaseTarget && chaseTarget.overs != null && ballsOfOvers(chaseTarget.overs) === firstBalls;

    const balls = [];
    const items = [];
    let t = 0;
    if (cutFromStart) items.push({ status: 'limit', inn: 1, overs: ballsLabel(firstBalls) });
    inns.forEach((inn, k) => {
      const bat = inn.team;
      const bowl = rival(bat);
      if (k === 1) {
        t += 20; // innings break
        const firstTotal = inns[0].overs.reduce((a, ov) => a + ov.deliveries.reduce((x, dl) => x + dl.runs.total, 0), 0) + penaltyOf(inns[0]);
        const overs = chaseTarget && chaseTarget.overs != null ? ballsOfOvers(chaseTarget.overs) : full;
        const runs = chaseTarget && chaseTarget.runs != null ? chaseTarget.runs : firstTotal + 1;
        // Only if the chase played to it. When rain ended a chase for good,
        // Cricsheet's target is the par score at that moment, which the
        // chase may already have passed; the result then says who won.
        const before = chaseBefore(inn);
        const playedTo = before.total < runs && before.balls < overs;
        if ((overs !== full || runs !== firstTotal + 1) && playedTo) items.push({ status: 'limit', inn: 2, overs: ballsLabel(overs), target: runs });
      }
      const start = balls.length;
      for (const ov of inn.overs) {
        for (const dl of ov.deliveries) {
          const ex = dl.extras || {};
          let extra = null;
          if (ex.wides) extra = 'wd';
          else if (ex.noballs) extra = 'nb';
          else if (ex.byes) extra = 'b';
          else if (ex.legbyes) extra = 'lb';
          ensure(bat, dl.batter); ensure(bat, dl.non_striker); ensure(bowl, dl.bowler);
          const ball = {
            inn: k + 1, over: ov.over, striker: dl.batter, nonStriker: dl.non_striker, bowler: dl.bowler,
            runs: dl.runs.batter, extras: dl.runs.extras - (ex.penalty || 0), extra, wicket: null,
          };
          if (ex.penalty) ball.penalty = ex.penalty;
          // Two dismissals on one ball (a batter bowled as the other retires
          // hurt): the ball's wicket is the first one that counts, and any
          // other that counts (a run out as the other batter retires out)
          // rides along.
          const ws = dl.wickets || [];
          const counted = ws.filter(counts);
          const w = counted[0] || ws[0];
          if (counted.length > 1) {
            ball.alsoOut = counted.slice(1).map((x) => ({ kind: KIND[x.kind] || 'other', out: x.player_out, how: x.kind }));
            for (const x of counted.slice(1)) ensure(bat, x.player_out);
          }
          if (w) {
            const kind = KIND[w.kind] || 'other';
            const f = w.fielders && w.fielders[0];
            const fielder = w.kind === 'caught and bowled' ? dl.bowler : (f && f.name) || null;
            if (fielder) ensure(bowl, fielder);
            ball.wicket = { kind, out: w.player_out, fielder };
            if (kind === 'other') ball.wicket.how = w.kind;
            ensure(bat, w.player_out);
          }
          const legal = extra !== 'wd' && extra !== 'nb';
          t += legal ? 0.6 : 0.3;
          if (w) t += 1;
          ball.t = Math.round(t * 100) / 100;
          balls.push(ball);
          items.push(ball);
        }
        t += 0.5;
      }
      // Penalty runs awarded before or after the innings ride on its first or last ball.
      const pen = inn.penalty_runs || {};
      if (pen.pre && balls[start]) balls[start].penalty = (balls[start].penalty || 0) + pen.pre;
      if (pen.post && balls.length > start) balls[balls.length - 1].penalty = (balls[balls.length - 1].penalty || 0) + pen.post;
    });

    // The result, when the balls alone cannot give it.
    const out = ci.outcome || {};
    const T = (name) => teams[ids[name]].short;
    let result = null;
    if (out.result === 'no result') result = { winner: null, text: 'No result' };
    else if (out.result === 'tie') {
      const so = out.eliminator || out.bowl_out;
      result = so ? { winner: ids[so], text: `Match tied. ${T(so)} win the ${out.eliminator ? 'super over' : 'bowl-out'}` } : { winner: null, text: 'Match tied' };
    } else if (out.winner && (out.method || inns.length < 2)) {
      const by = out.by || {};
      const how = out.method === 'D/L' ? ' (DLS)' : out.method ? ` (${out.method.toLowerCase()})` : '';
      result = out.method === 'Awarded' || inns.length < 2
        ? { winner: ids[out.winner], text: `${T(out.winner)} awarded the match` }
        : { winner: ids[out.winner], margin: runsLabel(by), text: `${T(out.winner)} win${runsLabel(by) ? ` by ${runsLabel(by)}` : ''}${how}` };
    }
    items.push(result ? { status: 'end', result } : { status: 'end' });

    const city = ci.city || '';
    const venue = ci.venue && city && !ci.venue.includes(city) ? `${ci.venue}, ${city}` : (ci.venue || city);
    const ev = ci.event || {};
    const event = o.event || [ev.name, ci.season, ev.stage || (ev.match_number ? `Match ${ev.match_number}` : '')].filter(Boolean).join(' ');
    return {
      info: {
        id: `cricsheet-${o.id || ''}`,
        teams, batFirst: ids[inns[0].team],
        event, venue, city,
        par: o.par != null ? o.par : null,           // Cricsheet has no par score; leave it out rather than guess
        scoring: o.scoring != null ? o.scoring : levelFor(o.levels, cs),
        chaseEdge: o.levels ? o.levels.edges[competitionOf(cs).key] || 0 : 0,
        competition: competitionOf(cs).name, gender: competitionOf(cs).gender,
        start: o.start != null ? o.start : 19 * 60 + 30,
        dateLabel: ci.dates && ci.dates[0] ? dateLabel(ci.dates[0]) : '',
        overs: ci.overs || 20, simulated: false, article: false,
        badge: 'Real replay',
        description: `A replay of a real match, ${event}, ball by ball. Times are estimated.`,
        credit: 'Ball-by-ball data from Cricsheet (cricsheet.org), Open Data Commons Attribution License.',
        outcome: ci.outcome || null,
      },
      balls,
      items,
    };
  }

  // ---------- which competition, and how high it scores ----------
  // Cricsheet's event names, with sponsors' renamings folded together.
  const ALIAS = {
    'NatWest T20 Blast': 'T20 Blast', 'Vitality Blast': 'T20 Blast', 'Vitality Blast Men': 'T20 Blast',
    'HRV Cup': 'Super Smash', 'HRV Twenty20': 'Super Smash',
    "New Zealand Cricket Women's Twenty20": "Women's Super Smash",
  };
  const FULL_MEMBERS = new Set(['Afghanistan', 'Australia', 'Bangladesh', 'England', 'India', 'Ireland', 'New Zealand',
    'Pakistan', 'South Africa', 'Sri Lanka', 'West Indies', 'Zimbabwe']);
  // "Indian Premier League|male", "T20I full members|female", ...
  function competitionOf(cs) {
    const i = cs.info;
    const gender = i.gender === 'female' ? 'female' : 'male';
    let name;
    if (i.team_type === 'international') name = i.teams.every((t) => FULL_MEMBERS.has(t)) ? 'T20I full members' : 'T20I associates';
    else name = ALIAS[i.event && i.event.name] || (i.event && i.event.name) || 'Other T20';
    const season = Number(String(i.season).slice(0, 4)) + (String(i.season).includes('/') ? 1 : 0);
    return { key: `${name}|${gender}`, name, gender, season };
  }
  // The scoring level to use for a match: its competition's average first
  // innings in the last season before this one, as data/levels.js has it,
  // or the usual level for men's or women's T20 when the competition is new.
  function levelFor(levels, cs) {
    if (!levels) return null;
    const c = competitionOf(cs);
    const by = levels.competitions[c.key];
    const before = by ? Object.keys(by).map(Number).filter((s) => s < c.season).sort((a, b) => a - b).pop() : null;
    return before != null ? by[before] : levels.defaults[c.gender];
  }

  // Cricsheet writes target overs as a number, 7.4 meaning 7 overs 4 balls.
  function ballsOfOvers(overs) {
    const [o, b] = String(overs).split('.');
    return Number(o) * 6 + Number(b || 0);
  }
  // Runs and balls (counted from the over number) before the last ball of an innings.
  function chaseBefore(inn) {
    const ds = inn.overs.flatMap((ov) => ov.deliveries.map((dl) => ({ ov: ov.over, dl })));
    let total = (inn.penalty_runs && inn.penalty_runs.pre) || 0;
    let balls = 0;
    let over = -1;
    let inOver = 0;
    for (const { ov, dl } of ds.slice(0, -1)) {
      total += dl.runs.total;
      if (ov !== over) { over = ov; inOver = 0; }
      if (isLegal(dl)) inOver++;
      balls = ov * 6 + Math.min(6, inOver);
    }
    return { total, balls };
  }
  // Penalty runs given outside any delivery (those on a delivery are in its runs).
  function penaltyOf(inn) {
    const p = inn.penalty_runs || {};
    return (p.pre || 0) + (p.post || 0);
  }

  return { toFeed, surname, initials, teamIds, competitionOf, levelFor };
});

