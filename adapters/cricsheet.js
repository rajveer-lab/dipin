/* Cricsheet adapter: turns a Cricsheet match file (cricsheet.org, JSON
   format) into a Dip In feed, { info, balls }, ready for the engine's
   createMatch and addBall. Cricsheet match data is free under the Open Data
   Commons Attribution License, so anything that shows it credits Cricsheet;
   the credit travels with the feed as info.credit.

   Cricsheet has no clock times, so ball times are estimated at the same
   pace the simulator uses. */
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

  // opts: { id, event, short: { [team name]: label }, par, scoring, start }
  //   scoring: typical first-innings total in that season, for the win model
  function toFeed(cs, opts) {
    const o = opts || {};
    const ci = cs.info;
    if (ci.match_type !== 'T20' && ci.match_type !== 'IT20') throw new Error(`Dip In models T20 only, not ${ci.match_type}`);
    const inns = cs.innings.filter((x) => !x.super_over).slice(0, 2);
    if (!inns.length) throw new Error('no innings in this match file');

    const ids = {};
    const teams = {};
    for (const name of ci.teams) {
      const id = initials(name);
      ids[name] = id;
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

    const balls = [];
    let t = 0;
    inns.forEach((inn, k) => {
      const bat = inn.team;
      const bowl = rival(bat);
      if (k === 1) t += 20; // innings break
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
            runs: dl.runs.batter, extras: dl.runs.extras, extra, wicket: null,
          };
          const w = (dl.wickets || [])[0];
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
        }
        t += 0.5;
      }
    });

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
        scoring: o.scoring != null ? o.scoring : null,
        start: o.start != null ? o.start : 19 * 60 + 30,
        dateLabel: ci.dates && ci.dates[0] ? dateLabel(ci.dates[0]) : '',
        overs: 20, simulated: false, article: false,
        badge: 'Real replay',
        description: `A replay of a real match, ${event}, ball by ball. Times are estimated.`,
        credit: 'Ball-by-ball data from Cricsheet (cricsheet.org), Open Data Commons Attribution License.',
        outcome: ci.outcome || null,
      },
      balls,
    };
  }

  return { toFeed, surname, initials };
});
