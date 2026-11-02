/* Dip In AI transport. Tries Claude through the claude.ai viewer's `sample`
   capability first, then a server route (api/ai) when the page is hosted with
   one. Every call resolves null when no AI is reachable, so the app can fall
   back to the built-in narrator without special cases. */
(function (root) {
  'use strict';

  // Errors after which this view will never reach Claude.
  const PERMANENT = ['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed', 'session_expired'];
  let samplePromise = null;
  let sampleOff = false;
  let serverOff = !/^https?:$/.test(location.protocol);
  let status = 'checking';
  const listeners = [];

  function setStatus(next) {
    if (next === status) return;
    status = next;
    listeners.forEach((fn) => fn(status));
  }

  function getSample() {
    if (sampleOff) return Promise.resolve(null);
    if (!samplePromise) {
      const host = root.claude;
      samplePromise = host && typeof host.use === 'function'
        ? host.use('sample').catch(() => null)
        : Promise.resolve(null);
    }
    return samplePromise;
  }

  async function server(body, signal) {
    if (serverOff) return null;
    try {
      const r = await fetch('api/ai', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
      });
      if (!r.ok) { if (r.status === 404 || r.status === 405) serverOff = true; return null; }
      return await r.json();
    } catch (e) {
      if (e && e.name === 'AbortError') throw { code: 'cancelled' };
      serverOff = true;
      return null;
    }
  }

  function noteFailure(e) {
    if (e && PERMANENT.includes(e.code)) { sampleOff = true; setStatus(serverOff ? 'off' : status); }
  }

  // Ask for one JSON value. Resolves the parsed value, or null.
  async function json(prompt) {
    const sample = await getSample();
    if (sample) {
      try {
        const value = await sample.json(prompt, { modelTier: 'quick' });
        setStatus('claude');
        return value;
      } catch (e) {
        noteFailure(e);
        if (!sampleOff) return null;
      }
    }
    const r = await server({ mode: 'json', prompt });
    if (r && r.value != null) { setStatus('server'); return r.value; }
    if (!sample || sampleOff) setStatus('off');
    return null;
  }

  // Chat turns in, reply text out (streamed through onText). Null when unavailable.
  async function chat(turns, opts) {
    const { onText, signal } = opts || {};
    const sample = await getSample();
    if (sample) {
      try {
        const { text } = await sample(turns, {
          modelTier: 'quick', cache: false, signal,
          onText: ({ text: soFar }) => onText && onText(soFar),
        });
        setStatus('claude');
        return text;
      } catch (e) {
        if (e && e.code === 'cancelled') throw e;
        noteFailure(e);
        if (e && e.text) return e.text;
        if (!sampleOff) return null;
      }
    }
    const r = await server({ mode: 'chat', messages: turns }, signal);
    if (r && r.text) { setStatus('server'); if (onText) onText(r.text); return r.text; }
    if (!sample || sampleOff) setStatus('off');
    return null;
  }

  function onStatus(fn) { listeners.push(fn); fn(status); }

  // Work out what this view can use, without spending anything.
  getSample().then(async (sample) => {
    if (sample) return setStatus('claude');
    if (!serverOff) {
      try {
        const r = await fetch('api/ai', { method: 'GET' });
        if (r.ok) return setStatus('server');
      } catch (e) { /* no server route */ }
      serverOff = true;
    }
    setStatus('off');
  });

  root.DipAI = { json, chat, onStatus, get status() { return status; } };
})(window);
