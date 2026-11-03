/* Dip In app: plays a match (the simulated demo or a real one replayed ball
   by ball), decides what the fan sees, and asks the AI for catch-ups and
   answers, with the built-in narrator as backup. */
(function () {
  'use strict';
  const E = window.DipEngine;
  const AI = window.DipAI;
  const Cs = window.DipCricsheet;
  const $ = (id) => document.getElementById(id);

  // Matches the app can play. Real ones come from Cricsheet files and go
  // through the same path a live feed would: E.createMatch, then E.push for
  // every ball and scoreboard message. data/levels.js tells the win model how
  // high that competition scores.
  function fromFeed(feed) {
    const m = E.createMatch(feed.info);
    for (const item of feed.items || feed.balls) E.push(m, item);
    return m;
  }
  const MATCHES = [{ key: 'demo', label: 'Demo match', hint: 'Made up, with a close finish', make: () => E.simulateMatch(E.SEED) }]
    .concat(Cs ? (window.DIPIN_REPLAYS || []).map((r) => ({
      key: `cs-${r.id}`, label: r.label, hint: 'Real match, replayed ball by ball',
      make: () => fromFeed(Cs.toFeed(r.cricsheet, Object.assign({ levels: window.DIPIN_LEVELS }, r.options))),
    })) : []);
  let M, INFO, B, LAST, FIRST, OPEN_FROM, OPEN_AT;
  let BAT1, BAT2;  // team batting first, team chasing
  let THE = 'the ';  // "the Falcons", but plain "CSK"
  // Replace a section's markup only when it changed, so buttons inside it
  // are not swapped out from under a click as the match ticks along.
  const shown = {};
  function setHtml(id, html) {
    if (shown[id] === html) return;
    shown[id] = html;
    $(id).innerHTML = html;
  }
  const esc =(v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function useMatch(key) {
    const pick = MATCHES.find((x) => x.key === key) || MATCHES[0];
    S.prefs.match = pick.key;
    M = pick.make();
    INFO = M.info;
    BAT1 = M.first;
    BAT2 = M.chase;
    B = M.balls;
    LAST = B.length - 1;
    FIRST = E.stateAt(M, M.innings[0].endIdx);
    THE = INFO.article === false ? '' : 'the ';
    // Opening scene: the fan stopped watching after 14 overs of the first
    // innings and is checking back in 8 overs into the chase.
    const overEnd = (inn, overs) => B.findIndex((d) => d.inn === inn && d.legal && d.legalBalls === overs * 6);
    OPEN_FROM = Math.max(0, overEnd(1, 14));
    OPEN_AT = overEnd(2, 8);
    if (OPEN_AT <= OPEN_FROM) OPEN_AT = LAST;
    const place = INFO.city || INFO.venue;
    $('match-title').textContent = `${name(1)} v ${name(2)} · ${INFO.event || 'T20'}${place ? ` · ${place}` : ''}`;
    $('sim-pill').hidden = !INFO.badge;
    $('sim-pill-text').textContent = INFO.badge || '';
    catchKey = '';
  }

  const SPEED_MS = { 1: 2200, 4: 550, 16: 140 };
  const AWAY_MS = 110; // time runs fast while the fan is away
  const GROUPS = [
    { id: 'tense', short: 'tense moments', label: 'The game gets tense', hint: 'Close finishes and moments one ball could swing' },
    { id: 'wickets', short: 'big wickets', label: 'Big wickets and collapses', hint: 'A set batter out, or wickets in a cluster' },
    { id: 'overs', short: 'big overs', label: 'Big overs and fifties', hint: 'Overs of 18 or more, 50s and 100s' },
    { id: 'breaks', short: 'innings break and result', label: 'Innings break and result', hint: 'When the target is set and when it ends' },
  ];
  const VERDICT = { watch_now: 'Watch now', worth_a_look: 'Worth a look', relax: 'Safe to step away' };
  const MARK = '<svg viewBox="0 0 32 32" aria-hidden="true"><circle class="mk-ball" cx="16" cy="11" r="6"/><path class="mk-wave" d="M3 23c4.5 0 4.5-5 9-5s4.5 5 9 5 4.5-5 8-5"/></svg>';
  const ICON = {
    away: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10.5 18.5h3"/></svg>',
    ask: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>',
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4"/><path d="M12 8v4l3 2"/></svg>',
  };
  // One drawn icon per alert group, shown in the alerts list.
  const GICON = {
    tense: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l2.5-6 5 12 2.5-6h4"/></svg>',
    wickets: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7v13M12 7v13M17 7v13M6 4.5h5.5M12.5 4.5H18"/></svg>',
    overs: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17l5.5-5.5 4 4L20 9"/><path d="M15 9h5v5"/></svg>',
    breaks: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>',
  };
  // The match's temperature as a hue: 225 (cool blue) when quiet, through
  // violet and magenta, to about 15 (hot red-orange) at the edge.
  const heatHue = (t) => 225 + 150 * Math.pow(Math.min(100, Math.max(0, t)) / 100, 0.8);

  const S = {
    cursor: 0, playing: true, speed: 1, mode: 'watching',
    away: null, hold: false, lockNotes: [],
    pending: null, // set by restart() for the chosen match
    catchUp: null,
    windows: [],
    fired: [],
    prefs: { match: 'demo', lang: 'en', team: 'neutral', groups: { tense: true, wickets: true, overs: false, breaks: true } },
    chat: [], chatBusy: false, chatCtl: null,
  };

  // ---------- preferences (this viewer only) ----------
  function loadPrefs() {
    try {
      const saved = JSON.parse(localStorage.getItem('dipin.prefs') || 'null');
      if (saved) {
        if (saved.match) S.prefs.match = saved.match;
        if (saved.lang) S.prefs.lang = saved.lang;
        if (saved.team) S.prefs.team = saved.team;
        if (saved.groups) Object.assign(S.prefs.groups, saved.groups);
      }
    } catch (e) { /* storage unavailable: defaults */ }
  }
  function savePrefs() {
    try { localStorage.setItem('dipin.prefs', JSON.stringify(S.prefs)); } catch (e) { /* ignore */ }
  }

  // Alerts the fan would already have received before the opening scene.
  function seedFired() {
    S.fired = [];
    for (let i = 0; i <= S.cursor; i++) {
      for (const a of B[i].alerts) if (S.prefs.groups[a.group]) S.fired.push({ idx: i, alert: a, away: i > OPEN_FROM });
    }
  }

  // ---------- small helpers ----------
  const team = (id) => INFO.teams[id];
  const name = (inn) => team(inn === 1 ? BAT1 : BAT2).short;
  const clock = (d) => E.clockLabel(d.t, INFO.start);
  const perspective = () => (S.prefs.team === BAT1 ? BAT1 : BAT2); // neutral fans see the chasing side
  const chanceOf = (d, side) => (side === BAT2 ? d.wp : 1 - d.wp);
  const minutesBetween = (a, b) => Math.max(0, Math.round(B[b].t - B[a].t));
  function scoreAt(i) {
    const d = B[i];
    return `${name(d.inn)} ${d.total}/${d.wkts} (${E.oversLabel(d.legalBalls)})`;
  }
  function chipHtml(sym) {
    let cls = 'chip';
    let label = sym;
    if (sym === 'W') cls += ' wkt';
    else if (sym === '4') cls += ' four';
    else if (sym === '6') cls += ' six';
    else if (/^(Wd|Nb)|\d(b|lb)$/.test(sym)) cls += ' extra';
    else if (sym === '0') { cls += ' dot'; label = '•'; }
    return `<span class="${cls}">${esc(label)}</span>`;
  }

  // ---------- what the AI sees ----------
  function matchData(s) {
    const o = {
      match: `T20${INFO.event ? ` (${INFO.event})` : ''}: ${team(BAT1).name} (batted first) v ${team(BAT2).name}${INFO.venue ? ` at ${INFO.venue}` : ''}.${INFO.description ? ` ${INFO.description}` : INFO.simulated ? ' A simulated match.' : ''}`,
      par_score_here: INFO.par || 'not known for this ground',
      innings: s.inn === 1 ? `${name(1)} batting, 1st innings` : `${name(2)} chasing, 2nd innings`,
      score: `${s.total}/${s.wkts} after ${s.overs} overs`,
      run_rate: s.crr,
      at_crease: s.batters.map((b) => `${b.name} ${b.runs}* off ${b.balls} (${b.fours} fours, ${b.sixes} sixes)${b.onStrike ? ', on strike' : ''}`),
      bowler_now: `${s.bowler.name} ${s.bowler.figures}`,
      bowlers_with_overs_left: s.bowlersLeft.filter((b) => b.oversLeft > 0).map((b) => `${b.name} (${b.type}${b.death ? ', death specialist' : ''}): ${b.oversLeft} left, ${b.figures} so far`),
      this_over: s.thisOver.join(' '),
      last_wicket: s.lastWicket ? `${s.lastWicket.name} ${s.lastWicket.how} ${s.lastWicket.runs} (${s.lastWicket.balls}), score ${s.lastWicket.score}` : 'none yet',
      partnership: `${s.partnership.runs} off ${s.partnership.balls} balls`,
      top_batters_this_innings: s.topBatters.map((b) => `${b.name} ${b.runs}${b.out ? '' : '*'} (${b.balls})`),
      top_bowlers_this_innings: s.topBowlers.map((b) => `${b.name} ${b.figures}`),
      win_chance_pct: { [name(1)]: 100 - Math.round(s.chaseWin * 100), [name(2)]: Math.round(s.chaseWin * 100) },
      tension: `${s.tension}/100 (${E.tensionLabel(s.tension)})`,
      last_balls: B.slice(Math.max(0, s.idx - 8), s.idx + 1).map((d) => `${d.label}: ${d.text}`),
    };
    if (s.inn === 2) {
      Object.assign(o, {
        target: M.target, need: `${s.need} off ${s.ballsLeft} balls`, required_rate: s.rrr,
        first_innings: `${name(1)} ${FIRST.total}/${FIRST.wkts} in ${FIRST.overs.replace(/\.0$/, '')} overs`,
        first_innings_top_batters: FIRST.topBatters.map((b) => `${b.name} ${b.runs}${b.out ? '' : '*'} (${b.balls})`),
        first_innings_top_bowlers: FIRST.topBowlers.map((b) => `${b.name} ${b.figures}`),
      });
    } else {
      o.projected_total = s.projected;
    }
    if (s.matchOver) o.result = s.result;
    return o;
  }
  function langRule() {
    return S.prefs.lang === 'hinglish'
      ? 'Write in Hinglish: everyday Hindi and English mixed, in Roman script, the way Indian fans text each other. Keep cricket terms in English.'
      : 'Write in plain, simple English.';
  }
  function fanRule() {
    if (S.prefs.team === 'neutral') return 'The fan does not support either side.';
    return `The fan supports ${team(S.prefs.team).name}. Say plainly whether the news is good or bad for them.`;
  }
  function catchUpPrompt(f) {
    const data = {
      away: { minutes: f.minutesAway, balls_missed: f.ballsMissed, score_when_fan_left: f.fromLabel },
      what_happened: f.segments.map((s) => ({
        team: s.team, from: `${s.fromScore} after ${s.fromOvers} overs`, to: `${s.toScore} after ${s.toOvers} overs`,
        runs: s.runs, wickets: s.wkts, balls: s.balls, fours: s.fours, sixes: s.sixes,
      })),
      moments_in_order: f.allEvents.map((e) => `${name(e.inn)} innings, ball ${e.at}: ${e.text}`),
      chasing_side_win_chance_pct: { side: name(2), when_fan_left: f.chaseChance.then, now: f.chaseChance.now },
      tension_now: `${f.tension}/100 (${f.tensionLabel})`,
      live_now: matchData(f.now),
    };
    return [
      'You are Dip In, a cricket companion for fans who follow live matches in fragments: at work, in class, on the move.',
      'A fan has just come back to the match. Write their catch-up.',
      '',
      'Rules:',
      '- Use only facts from MATCH DATA. Never invent players, scores, overs or events. Every number you write must appear in MATCH DATA.',
      `- ${langRule()}`,
      `- ${fanRule()}`,
      '- Sound like a friend who watched it for them. Short sentences, no commentary cliches. Refer to players by surname.',
      '- verdict is "watch_now" if tension is 70 or more, "worth_a_look" if 45 to 69, "relax" if below 45 or the match is over.',
      '',
      'Reply with only this JSON:',
      '{"headline": "<max 9 words>", "lines": ["<what happened while they were away, max 25 words>", "<the moment that mattered most and why, max 25 words>", "<what to watch for next, max 25 words>"], "verdict": "watch_now|worth_a_look|relax", "verdict_reason": "<max 12 words>"}',
      '',
      'MATCH DATA:',
      JSON.stringify(data, null, 1),
    ].join('\n');
  }
  function chatRules() {
    return [
      "You are Dip In, a friendly cricket companion inside a live-match app. Answer the fan's question about this match.",
      'Rules:',
      "- For match facts, use only the LIVE MATCH DATA in the fan's latest message. If something is not in it, say you don't have that information.",
      '- For rules questions (free hit, DLS, Impact Player, net run rate, powerplay), explain simply in one or two sentences and tie it to this match where you can.',
      '- At most 70 words. Plain sentences: no headings, no bullet lists, no markdown.',
      `- ${langRule()}`,
      `- ${fanRule()}`,
    ].join('\n');
  }
  const validCatchUp = (v) => v && typeof v.headline === 'string' && Array.isArray(v.lines) && v.lines.length >= 2
    && v.lines.every((l) => typeof l === 'string') && Object.prototype.hasOwnProperty.call(VERDICT, v.verdict);

  // ---------- catch-up ----------
  async function catchUp(from, to) {
    S.pending = null;
    const facts = E.windowFacts(M, from, to);
    const job = { from, to, facts, status: 'loading', data: null, source: null };
    S.catchUp = job;
    render();
    $('catchup').scrollIntoView({ block: 'start', behavior: 'smooth' });
    const ai = await AI.json(catchUpPrompt(facts));
    if (S.catchUp !== job) return; // the fan has stepped away again since
    if (validCatchUp(ai)) { job.data = ai; job.source = AI.status === 'server' ? 'server' : 'claude'; }
    else { job.data = E.localCatchUp(facts, S.prefs.lang); job.source = 'local'; }
    job.status = 'done';
    render();
  }

  // ---------- ask ----------
  async function ask(q) {
    if (S.chatBusy || !q.trim()) return;
    const s = E.stateAt(M, S.cursor);
    const history = S.chat.filter((m) => !m.pending && m.text).slice(-6).map((m) => ({ role: m.role, content: m.text }));
    const turns = [
      { role: 'user', content: chatRules() },
      ...history,
      { role: 'user', content: `LIVE MATCH DATA (after ball ${s.label}, ${s.time}):\n${JSON.stringify(matchData(s))}\n\nFan's question: ${q}` },
    ];
    S.chat.push({ role: 'user', text: q });
    const reply = { role: 'assistant', text: '', source: null, pending: true };
    S.chat.push(reply);
    S.chatBusy = true;
    const ctl = new AbortController();
    S.chatCtl = ctl;
    renderChat();
    let text = null;
    try {
      text = await AI.chat(turns, { signal: ctl.signal, onText: (t) => { reply.text = t; renderChat(); } });
    } catch (e) {
      text = reply.text || null;
    }
    if (text) { reply.text = text; reply.source = AI.status === 'server' ? 'server' : 'claude'; }
    else {
      reply.text = E.localAnswer(q, s) || "Live AI isn't connected in this view, so I can only answer the suggested questions right now.";
      reply.source = 'local';
    }
    reply.pending = false;
    S.chatBusy = false;
    S.chatCtl = null;
    renderChat();
  }

  // ---------- the match clock ----------
  function advance() {
    S.cursor++;
    const d = B[S.cursor];
    for (const a of d.alerts) {
      if (!S.prefs.groups[a.group]) continue;
      const rec = { idx: S.cursor, alert: a, away: S.mode === 'away' };
      S.fired.push(rec);
      if (S.mode === 'away') {
        S.lockNotes.unshift(rec);
        if (a.group === 'tense' || a.kind === 'result') S.hold = true;
      } else toast(a);
    }
    if (S.cursor >= LAST) S.playing = false;
  }
  let acc = 0;
  let lastFrame = performance.now();
  function frame(now) {
    const dt = Math.min(1000, now - lastFrame);
    lastFrame = now;
    const away = S.mode === 'away';
    if (S.cursor < LAST && (away ? !S.hold : S.playing)) {
      acc += dt;
      const step = away ? AWAY_MS : SPEED_MS[S.speed];
      let moved = false;
      while (acc >= step && S.cursor < LAST && !(S.mode === 'away' && S.hold)) { acc -= step; advance(); moved = true; }
      if (moved) render();
    } else acc = 0;
    requestAnimationFrame(frame);
  }

  function stepAway() {
    if (S.cursor >= LAST) return;
    closeSheets();
    S.mode = 'away';
    S.away = { from: S.cursor };
    S.hold = false;
    S.lockNotes = [];
    S.pending = null;
    acc = 0;
    render();
    const back = $('lock').querySelector('[data-action="come-back"]');
    if (back) back.focus();
  }
  function comeBack() {
    if (S.mode !== 'away') return;
    const from = S.away.from;
    const to = S.cursor;
    S.mode = 'watching';
    S.away = null;
    S.hold = false;
    if (to > from) { S.windows.push({ from, to }); catchUp(from, to); } else render();
  }
  function restart() {
    closeSheets();
    Object.assign(S, {
      cursor: OPEN_AT, playing: true, mode: 'watching', away: null, hold: false, lockNotes: [],
      pending: { from: OPEN_FROM, to: OPEN_AT }, catchUp: null, windows: [{ from: OPEN_FROM, to: OPEN_AT }], chat: [],
    });
    seedFired();
    render();
    window.scrollTo(0, 0);
  }

  // ---------- rendering ----------
  function renderBoard(s) {
    let status = '<span class="tag tag-live"><i></i>Live</span>';
    if (s.matchOver) status = '<span class="tag tag-result">Result</span>';
    else if (s.inningsOver) status = '<span class="tag">Innings break</span>';
    let sub;
    if (s.inn === 2) {
      sub = s.matchOver ? `<b>${esc(s.result)}</b>` : `Need <b>${s.need}</b> off <b>${s.ballsLeft}</b> · RRR ${s.rrr} · CRR ${s.crr}`;
    } else {
      sub = s.inningsOver ? `${name(2)} need <b>${M.target}</b> to win` : `Projected <b>${s.projected}</b>${INFO.par ? ` · Par ${INFO.par}` : ''} · CRR ${s.crr}`;
    }
    const line = {
      [BAT1]: s.inn === 1 ? { score: `${s.total}/${s.wkts}`, overs: `${s.overs} ov` } : { score: `${FIRST.total}/${FIRST.wkts}`, overs: `${FIRST.overs.replace(/\.0$/, '')} ov` },
      [BAT2]: s.inn === 2 ? { score: `${s.total}/${s.wkts}`, overs: `${s.overs} ov` } : { score: '', overs: 'Yet to bat' },
    };
    const teams = [BAT1, BAT2].map((id, i) => `
      <div class="team-row${s.batTeam === id ? ' batting' : ''}">
        <span class="crest crest-${i + 1}" aria-hidden="true">${esc(id)}</span>
        <span class="team-name">${esc(team(id).name)}</span>
        <span class="team-score">${line[id].score ? `<b>${line[id].score}</b>` : ''}<em>${line[id].overs}</em></span>
      </div>`).join('');
    const batters = s.batters.map((b) => `<div class="bat${b.onStrike ? ' on' : ''}"><span>${esc(b.short)}${b.onStrike ? '*' : ''}</span><b>${b.runs}</b><em>(${b.balls})</em></div>`).join('');
    const crease = s.inningsOver ? '' : `
      <div class="crease">
        <div><div class="crease-label">Batting</div>${batters}</div>
        <div>
          <div class="crease-label">Bowling</div>
          <div class="bowl"><span>${esc(s.bowler.short)}</span><b>${esc(s.bowler.figures)}</b></div>
          <div class="crease-label gap">This over</div>
          <div class="over-chips">${s.thisOver.map(chipHtml).join('')}</div>
        </div>
      </div>`;
    setHtml('board', `
      <div class="board-top">${status}<span>${s.inn === 1 ? '1st innings' : '2nd innings'} · Over ${s.overs}</span></div>
      <div class="teams">${teams}</div>
      <p class="chase">${sub}</p>
      ${crease}`);
  }

  function renderWin(s) {
    const fp = Math.round(s.chaseWin * 100);
    const tp = 100 - fp;
    setHtml('winbar', `
      <div class="win-labels"><span class="t">${esc(name(1))} <b>${tp}%</b></span><span class="win-title">Win chance</span><span class="f"><b>${fp}%</b> ${esc(name(2))}</span></div>
      <div class="win-track" role="img" aria-label="${esc(name(1))} ${tp} percent, ${esc(name(2))} ${fp} percent"><span class="t" style="flex-basis:${tp}%"></span><span class="f" style="flex-basis:${fp}%"></span></div>`);
  }

  function renderMeter(s) {
    const t = s.tension;
    const v = s.matchOver ? 'relax' : E.verdictFor(t);
    const label = s.matchOver ? 'Match over' : VERDICT[v];
    // A finished match cools the page right down, whatever the last ball did.
    document.documentElement.style.setProperty('--heat', heatHue(s.matchOver ? 8 : t).toFixed(1));
    setHtml('meter', `
      <p class="ask-line">Should I watch?</p>
      <h1 class="verdict">${label}</h1>
      <div class="heat-read"><b>${t}</b><span>tension<br>${esc(E.tensionLabel(t).toLowerCase())}</span></div>
      <div class="heat">
        <div class="heat-rail" role="img" aria-label="Tension ${t} out of 100"><i style="left:${t}%"></i></div>
        <div class="heat-scale" aria-hidden="true"><span>Quiet</span><span>Simmering</span><span>Tense</span><span>Edge</span></div>
      </div>
      <p class="reason">${esc(E.tensionReason(s))}</p>`);
  }

  function renderActions() {
    let welcome = '';
    if (S.pending) {
      const mins = minutesBetween(S.pending.from, S.pending.to);
      welcome = `
        <div class="back-card">
          <p><strong>You've been away for ${mins} minutes</strong>You left at ${esc(scoreAt(S.pending.from))} and missed ${S.pending.to - S.pending.from} balls${B[S.pending.from].inn !== B[S.pending.to].inn ? ', including the innings break' : ''}.</p>
          <button class="btn btn-primary" type="button" data-action="catch-up">${ICON.back}Catch me up</button>
        </div>`;
    }
    setHtml('welcome', welcome);
    const over = S.cursor >= LAST;
    let html = `
      <div class="btn-row">
        <button class="btn${S.pending ? '' : ' btn-primary'}" type="button" data-action="step-away"${over ? ' disabled' : ''}>${ICON.away}Step away</button>
        <button class="btn" type="button" data-action="open-ask">${ICON.ask}Ask</button>
      </div>`;
    if (!over) {
      html += '<p class="fine"><b>Step away</b> when you put your phone down. Dip In keeps following the match and pings you only when it\'s worth coming back (you pick the moments in Settings), then tells you what you missed. In this demo, match time runs fast while you\'re away.</p>';
    }
    setHtml('actions', html);
  }

  function spark(from, to, side) {
    const w = 160;
    const h = 34;
    const n = Math.max(1, to - from);
    const pts = [];
    for (let i = from; i <= to; i++) {
      pts.push(`${(((i - from) / n) * w).toFixed(1)},${(h - 3 - chanceOf(B[i], side) * (h - 6)).toFixed(1)}`);
    }
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2="${w}" y1="${h / 2}" y2="${h / 2}" stroke="var(--line)" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/><polyline points="${pts.join(' ')}" fill="none" stroke="var(${side === BAT2 ? '--side2' : '--side1'})" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
  }

  let catchKey = '';
  function renderCatchUp() {
    const c = S.catchUp;
    const key = c ? `${c.from}-${c.to}-${c.status}-${S.prefs.team}` : '';
    if (key === catchKey) return;
    catchKey = key;
    if (!c) { $('catchup').innerHTML = ''; return; }
    const f = c.facts;
    const srcLabel = { claude: 'Written by Claude', server: 'Written by AI', local: 'Built-in summary' }[c.source];
    const head = `<div class="cu-head"><span class="cu-meta">While you were away · <b>${f.minutesAway}</b> min · <b>${f.ballsMissed}</b> balls</span>${c.status === 'done' ? `<span class="src ${c.source === 'local' ? '' : 'claude'}">${srcLabel}</span>` : ''}</div>`;
    if (c.status === 'loading') {
      $('catchup').innerHTML = `<div class="card catchup">${head}<p class="fine">Reading the ${f.ballsMissed} balls you missed…</p><div class="skeleton"><i></i><i></i><i></i></div></div>`;
      return;
    }
    const d = c.data;
    const labels = S.prefs.lang === 'hinglish' ? ['Kya hua', 'Kya badla', 'Ab aage'] : ['Happened', 'Mattered', 'Next'];
    const lines = d.lines.slice(0, 3).map((l, i) => `<li><span>${labels[i]}</span><span>${esc(l)}</span></li>`).join('');
    const side = perspective();
    const ch = (i) => Math.round(chanceOf(B[i], side) * 100);
    const moments = f.keyEvents.length ? `
      <div>
        <h3 class="sub-title">Key moments</h3>
        <ul class="moments">${f.keyEvents.map((e) => `<li><span class="over-tag">${esc(e.inn === 1 ? BAT1 : BAT2)} ${esc(e.at)}</span><span>${esc(e.text)}</span></li>`).join('')}</ul>
      </div>` : '';
    $('catchup').innerHTML = `
      <div class="card catchup">
        ${head}
        <h2 class="cu-headline">${esc(d.headline)}</h2>
        <ul class="cu-lines">${lines}</ul>
        <div class="cu-verdict ${d.verdict}"><b>${VERDICT[d.verdict]}</b><span>${esc(d.verdict_reason || '')}</span></div>
        <div class="cu-swing"><span>${team(side).short} win chance <b>${ch(c.from)}% → ${ch(c.to)}%</b></span>${spark(c.from, c.to, side)}</div>
        ${moments}
        <p class="fine">${c.source === 'local'
          ? "Live AI isn't connected in this view, so this summary comes from Dip In's built-in templates."
          : `Written from the ${f.ballsMissed} balls you missed. Every number comes from the match data.`}</p>
      </div>`;
  }

  function renderChart() {
    const side = perspective();
    const col = side === BAT2 ? 'var(--side2)' : 'var(--side1)';
    const W = 360, H = 178, X0 = 44, X1 = 354, Y0 = 8, Y1 = 108, T0 = 122, T1 = 150, SPAN = 248;
    const pos = (inn, balls) => X0 + (((inn - 1) * 128 + balls) / SPAN) * (X1 - X0);
    const xOf = (d) => pos(d.inn, d.legalBalls);
    const yOf = (v) => Y1 - v * (Y1 - Y0);
    const seen = B.slice(0, S.cursor + 1);
    const pts = seen.map((d) => `${xOf(d).toFixed(1)},${yOf(chanceOf(d, side)).toFixed(1)}`).join(' ');
    const shade = S.windows.map((w) => {
      const a = xOf(B[w.from]);
      const b = xOf(B[w.to]);
      return `<rect x="${a.toFixed(1)}" y="${Y0}" width="${Math.max(1, b - a).toFixed(1)}" height="${Y1 - Y0}" fill="var(--away)"/>`;
    }).join('');
    const overs = new Map();
    for (const d of seen) {
      const k = `${d.inn}-${d.over}`;
      const o = overs.get(k) || { inn: d.inn, over: d.over, t: 0 };
      o.t = Math.max(o.t, d.tension);
      overs.set(k, o);
    }
    const barW = (6 / SPAN) * (X1 - X0) - 1;
    const bars = [...overs.values()].map((o) => {
      const h = Math.max(1.5, (o.t / 100) * (T1 - T0));
      const c = `hsl(${heatHue(o.t).toFixed(0)} 72% 52%)`;
      return `<rect x="${pos(o.inn, o.over * 6).toFixed(1)}" y="${(T1 - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="1.2" fill="${c}"/>`;
    }).join('');
    const marks = S.fired.map((r) => {
      const d = B[r.idx];
      return `<circle cx="${xOf(d).toFixed(1)}" cy="${yOf(chanceOf(d, side)).toFixed(1)}" r="3.2" fill="var(--surface)" stroke="var(--ink)" stroke-width="1.4"/>`;
    }).join('');
    const end = seen[seen.length - 1];
    const brk = pos(1, 124);
    const grid = [0, 0.5, 1].map((v) => `<line x1="${X0}" x2="${X1}" y1="${yOf(v)}" y2="${yOf(v)}" stroke="var(--line)"${v === 0.5 ? ' stroke-dasharray="3 3"' : ''}/><text x="${X0 - 6}" y="${yOf(v) + 3.5}" text-anchor="end">${v * 100}%</text>`).join('');
    const now = Math.round(chanceOf(end, side) * 100);
    setHtml('chart', `
      <div class="card-head"><h2 class="card-title">How the match has moved</h2><span class="meta">${esc(team(side).short)} win chance</span></div>
      <div class="chart">
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(team(side).short)} win chance through the match, now ${now} percent. Shaded stretches are when you were away.">
          ${shade}${grid}
          <line x1="${brk}" x2="${brk}" y1="${Y0}" y2="${T1}" stroke="var(--line)"/>
          <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2.2" stroke-linejoin="round"/>
          ${marks}
          <circle cx="${xOf(end).toFixed(1)}" cy="${yOf(chanceOf(end, side)).toFixed(1)}" r="4.5" fill="${col}"/>
          <text x="${X0 - 6}" y="${T1 - 3}" text-anchor="end">tension</text>
          <line x1="${X0}" x2="${X1}" y1="${T1 + 0.5}" y2="${T1 + 0.5}" stroke="var(--line)"/>
          ${bars}
          <text x="${((X0 + brk) / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(name(1))} batting</text>
          <text x="${((brk + X1) / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(name(2))} chasing</text>
        </svg>
        <div class="legend">
          <span><i style="background:${col}"></i>${esc(team(side).short)} win chance</span>
          <span><i style="background:var(--away)"></i>You were away</span>
          <span><i style="background:var(--surface);border:1.5px solid var(--ink);border-radius:50%"></i>Alert sent</span>
          <span><i class="heat-swatch"></i>Tension per over</span>
        </div>
      </div>`);
  }

  function renderAlerts() {
    const items = S.fired.slice().reverse().slice(0, 8);
    const on = GROUPS.filter((g) => S.prefs.groups[g.id]).map((g) => g.short).join(', ') || 'nothing';
    const body = items.length
      ? `<ul class="list">${items.map((r) => `
          <li class="alert">
            <span class="a-icon g-${r.alert.group}">${GICON[r.alert.group] || ''}</span>
            <span class="alert-title">${esc(r.alert.title)}${r.away ? '<span class="away-tag">sent while away</span>' : ''}</span>
            <span class="alert-body">${esc(r.alert.body)}</span>
            <span class="meta">${clock(B[r.idx])} · ${esc(name(B[r.idx].inn))} ${esc(B[r.idx].label)}</span>
          </li>`).join('')}</ul>`
      : '<p class="empty">No alerts yet.</p>';
    setHtml('alerts', `
      <div class="card-head"><h2 class="card-title">Alerts</h2><button type="button" class="linkish" data-action="open-settings">Pinging you for ${esc(on)}</button></div>
      ${body}`);
  }

  function renderFeed() {
    const rows = [];
    for (let i = S.cursor; i >= 0 && rows.length < 12; i--) {
      const d = B[i];
      if (i < S.cursor && B[i + 1].inn !== d.inn) rows.push(`<li class="feed-break">Innings break · ${esc(name(2))} need ${M.target}</li>`);
      const cls = d.wicket ? 'w' : d.runs === 4 || d.runs === 6 ? 'b' : '';
      rows.push(`<li class="ball-row"><span class="over-no">${esc(d.label)}</span>${chipHtml(E.symbol(d))}<span class="feed-text ${cls}">${esc(d.text)}</span></li>`);
    }
    setHtml('feed', `
      <div class="card-head"><h2 class="card-title">Ball by ball</h2><span class="meta">${esc(name(B[S.cursor].inn))} batting</span></div>
      <ul class="list">${rows.join('')}</ul>
      ${INFO.credit ? `<p class="fine credit">${esc(INFO.credit)}</p>` : ''}`);
  }

  function renderLock() {
    const lock = $('lock');
    if (S.mode !== 'away') {
      lock.hidden = true;
      if (!sheet) document.body.classList.remove('no-scroll');
      return;
    }
    lock.hidden = false;
    document.body.classList.add('no-scroll');
    const d = B[S.cursor];
    const mins = minutesBetween(S.away.from, S.cursor);
    const balls = S.cursor - S.away.from;
    const ended = S.cursor >= LAST;
    const notes = S.lockNotes.length
      ? S.lockNotes.map((r) => `
          <button type="button" class="note" data-action="come-back">
            <span class="note-icon">${MARK}</span>
            <span class="note-top"><span>Dip In</span><span>${clock(B[r.idx])}</span></span>
            <span class="note-title">${esc(r.alert.title)}</span>
            <span class="note-body">${esc(r.alert.body)}</span>
          </button>`).join('')
      : '<div class="lock-empty">Nothing worth your time yet. Dip In will ping you when there is.</div>';
    const foot = S.hold || ended
      ? `<p class="lock-hold">${ended ? 'The match has finished.' : 'Paused at this alert so you can read it.'}</p>
         <button type="button" class="btn btn-primary" data-action="come-back">I'm back, catch me up</button>
         ${ended ? '' : '<button type="button" class="btn btn-ghost" data-action="stay-away">Stay away</button>'}`
      : '<button type="button" class="btn btn-primary" data-action="come-back">I\'m back, catch me up</button>';
    setHtml('lock-clock', `<b>${clock(d).replace(/ (AM|PM)$/, '')}</b><span>${esc(INFO.dateLabel)}</span>`);
    setHtml('lock-status', `Away for <b>${mins} min</b> · ${balls} balls bowled<br>Dip In is following ${esc(name(1))} v ${esc(name(2))} for you`);
    setHtml('lock-notes', notes);
    setHtml('lock-foot', `${foot}<p class="fine">Demo: match time runs fast while you're away.</p>`);
  }

  function renderDemo() {
    const ended = S.cursor >= LAST;
    const btn = $('play-btn');
    btn.textContent = ended ? 'Ended' : S.playing ? 'Pause' : 'Play';
    btn.disabled = ended;
    btn.setAttribute('aria-label', S.playing ? 'Pause the match' : 'Play the match');
    document.querySelectorAll('[data-action="speed"]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === S.speed)));
    $('demo-clock').textContent = `${clock(B[S.cursor])} · ${name(B[S.cursor].inn)} ${B[S.cursor].label}`;
  }

  function render() {
    const s = E.stateAt(M, S.cursor);
    renderBoard(s);
    renderWin(s);
    renderMeter(s);
    renderActions();
    renderCatchUp();
    renderChart();
    renderAlerts();
    renderFeed();
    renderLock();
    renderDemo();
  }

  // ---------- toast ----------
  let toastTimer = null;
  function toast(a) {
    const el = $('toast');
    el.innerHTML = `<b>${esc(a.title)}</b>${esc(a.body)}`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
  }

  // ---------- sheets ----------
  let sheet = null;
  let lastFocus = null;
  function openSheet(name) {
    closeSheets();
    sheet = name;
    lastFocus = document.activeElement;
    $('scrim').hidden = false;
    $(`sheet-${name}`).hidden = false;
    document.body.classList.add('no-scroll');
    if (name === 'ask') { renderChips(); renderChat(); $('ask-input').focus(); }
    else { renderSettings(); const first = $('settings').querySelector('input, button'); if (first) first.focus(); }
  }
  function closeSheets() {
    if (!sheet) return;
    $('scrim').hidden = true;
    $('sheet-ask').hidden = true;
    $('sheet-settings').hidden = true;
    sheet = null;
    if (S.mode !== 'away') document.body.classList.remove('no-scroll');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function renderChips() {
    const s = E.stateAt(M, S.cursor);
    let qs;
    if (s.matchOver) qs = ['Who was the star of the match?', 'Where was the match won?', 'What is a free hit?'];
    else if (s.inn === 1) qs = ['Is this a good score here?', 'Who is the danger man?', 'What is a free hit?', 'Explain DLS simply'];
    else qs = ['What do they need?', 'Who is the danger man?', `Can ${THE}${name(2)} still win?`, 'Why is the tension so high?'];
    setHtml('ask-chips', qs.map((q) => `<button type="button" data-action="chip" data-q="${esc(q)}">${esc(q)}</button>`).join(''));
  }
  function renderChat() {
    const box = $('chat');
    box.innerHTML = S.chat.length
      ? S.chat.map((m) => (m.role === 'user'
        ? `<div class="msg user">${esc(m.text)}</div>`
        : `<div class="msg assistant">${m.pending && !m.text ? 'Thinking…' : esc(m.text)}${m.pending ? '' : `<span class="by">${{ claude: 'Claude', server: 'Live AI', local: 'Built-in answer' }[m.source]}</span>`}</div>`)).join('')
      : '<p class="empty">Ask anything about the match: the chase, the players, or a rule you don\'t get.</p>';
    $('ask-send').textContent = S.chatBusy ? 'Stop' : 'Ask';
    const lastMsg = box.lastElementChild;
    if (lastMsg) lastMsg.scrollIntoView({ block: 'nearest' });
  }
  function aiNote() {
    switch (AI.status) {
      case 'claude': return 'Catch-ups and answers are written live by Claude from the match data. Alerts come from the tension model, so they arrive instantly.';
      case 'server': return 'Catch-ups and answers are written live by AI from the match data. Alerts come from the tension model, so they arrive instantly.';
      case 'off': return "Live AI isn't connected in this view. Catch-ups use built-in templates and Ask answers only the suggested questions.";
      default: return 'Checking whether live AI is available…';
    }
  }
  function renderSettings() {
    const toggles = GROUPS.map((g) => `
      <label class="toggle" for="g-${g.id}">
        <span>${esc(g.label)}</span><small>${esc(g.hint)}</small>
        <input type="checkbox" id="g-${g.id}" data-group="${g.id}"${S.prefs.groups[g.id] ? ' checked' : ''}>
      </label>`).join('');
    const seg = (name, opts, val) => `<div class="seg seg-wide" role="group">${opts.map(([v, l]) => `<button type="button" data-action="pref" data-pref="${name}" data-value="${v}" aria-pressed="${v === val}">${l}</button>`).join('')}</div>`;
    const matches = MATCHES.length < 2 ? '' : `
      <div class="set-group"><h3>Match</h3>
        <div class="choices">${MATCHES.map((x) => `
          <button type="button" class="choice" data-action="pref" data-pref="match" data-value="${x.key}" aria-pressed="${x.key === S.prefs.match}">
            <b>${esc(x.label)}</b><small>${esc(x.hint)}</small>
          </button>`).join('')}</div>
        ${INFO.credit ? `<p class="fine">${esc(INFO.credit)}</p>` : ''}
      </div>`;
    setHtml('settings', `${matches}
      <div class="set-group"><h3>Ping me when</h3>${toggles}</div>
      <div class="set-group"><h3>Catch-up language</h3>${seg('lang', [['en', 'English'], ['hinglish', 'Hinglish']], S.prefs.lang)}</div>
      <div class="set-group"><h3>I support</h3>${seg('team', [[BAT1, esc(name(1))], ['neutral', 'Neither'], [BAT2, esc(name(2))]], S.prefs.team)}</div>
      <p class="fine">${esc(aiNote())}</p>`);
  }

  // ---------- events ----------
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-action]');
    if (!el || el.disabled) return;
    switch (el.dataset.action) {
      case 'catch-up': if (S.pending) catchUp(S.pending.from, S.pending.to); break;
      case 'step-away': stepAway(); break;
      case 'come-back': comeBack(); break;
      case 'stay-away': S.hold = false; render(); break;
      case 'open-ask': openSheet('ask'); break;
      case 'open-settings': openSheet('settings'); break;
      case 'close-sheets': closeSheets(); break;
      case 'toggle-play': S.playing = !S.playing; acc = 0; renderDemo(); break;
      case 'speed': S.speed = Number(el.dataset.speed); acc = 0; renderDemo(); break;
      case 'restart': restart(); break;
      case 'pref':
        if (el.dataset.pref === 'match') {
          if (el.dataset.value !== S.prefs.match) { useMatch(el.dataset.value); savePrefs(); restart(); }
          break;
        }
        S.prefs[el.dataset.pref] = el.dataset.value;
        savePrefs();
        renderSettings();
        catchKey = '';
        render();
        break;
      case 'chip': ask(el.dataset.q); break;
      default: break;
    }
  });
  $('settings').addEventListener('change', (ev) => {
    const g = ev.target.dataset.group;
    if (!g) return;
    S.prefs.groups[g] = ev.target.checked;
    savePrefs();
    render();
  });
  $('ask-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (S.chatBusy) { if (S.chatCtl) S.chatCtl.abort(); return; }
    const input = $('ask-input');
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    ask(q);
  });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeSheets(); });

  AI.onStatus((st) => {
    const chip = $('ai-chip');
    chip.dataset.state = st;
    chip.textContent = { checking: 'Checking AI', claude: 'Live AI · Claude', server: 'Live AI', off: 'Built-in mode' }[st] || st;
    if (sheet === 'settings') renderSettings();
  });

  loadPrefs();
  useMatch(S.prefs.match);
  restart();
  requestAnimationFrame(frame);
})();

