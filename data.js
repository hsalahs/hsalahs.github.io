// Data layer for the Supabase migration. invite.html uses Data.invite.* (the
// Supabase implementation below); the other pages still use the Firebase side
// (ready / normalizeError) until they are rewritten. Classic script:
// firebase-init.js is a deferred module that runs after it, so nothing here
// may read window._db / _fsFns / _authFns / _auth or window.supabase at load
// time. Everything is looked up when a function is called.
(function () {
  // Errors leave the layer as DataError. Only the codes in MAPPED are renamed;
  // anything else keeps the original Firestore/Auth code string (or 'unknown'
  // when there was none), so alerts that print e.code read exactly as before.
  class DataError extends Error {
    constructor(code, message, cause) {
      super(message || code);
      this.name = 'DataError';
      this.code = code;
      this.cause = cause;
    }
  }

  const MAPPED = {
    'permission-denied': 'permission',
    'unavailable': 'offline',
    'deadline-exceeded': 'timeout',
    'not-found': 'not-found',
    'auth/invalid-credential': 'invalid-credential',
    'auth/wrong-password': 'invalid-credential',
    'auth/user-not-found': 'invalid-credential',
    'auth/invalid-email': 'invalid-email',
    'auth/email-already-in-use': 'email-in-use',
    'auth/weak-password': 'weak-password',
    'auth/network-request-failed': 'offline',
  };

  // Page-internal sentinels, thrown as new Error('GATE') etc. and matched on
  // e.message by the pages today.
  const SENTINELS = {
    'GATE': 'cap-reached',
    'ALREADY': 'already-handled',
    'SLUG_TAKEN': 'slug-taken',
  };

  // Same test as window._isFirestoreTerminated in firebase-init.js.
  function isTerminated(err) {
    if (typeof window._isFirestoreTerminated === 'function') return window._isFirestoreTerminated(err);
    return !!(err && /already been terminated/i.test(err.message || ''));
  }

  // Supabase: the SQL functions raise their error NAME as the exception
  // message (see supabase/README.md), so the message is matched first, then
  // the Postgres / PostgREST code, then the Auth error code.
  const SQL_MESSAGES = [
    ['GUEST_LIMIT_REACHED', 'cap-reached'],
    ['LIMIT_REACHED', 'limit-reached'],
    ['CEILING_REACHED', 'ceiling-reached'],
    ['REQUESTS_FULL', 'requests-full'],
    ['SLUG_TAKEN', 'slug-taken'],
    ['NO_SESSION', 'no-session'],
    ['NOT_PENDING', 'already-handled'],
    ['CANNOT_DELETE_ADMIN', 'cannot-delete-admin'],
    ['NOT_ALLOWED', 'permission'],
    ['EVENT_NOT_FOUND', 'not-found'],
    ['REQUEST_NOT_FOUND', 'not-found'],
    ['USER_NOT_FOUND', 'not-found'],
    ['NO_LIMIT_ROW', 'not-found'],
    ['BAD_NAME', 'bad-input'],
    ['BAD_INPUT', 'bad-input'],
    ['BAD_REQUEST_ID', 'bad-input'],
    ['BAD_SLUG', 'bad-input'],
    ['BATCH_TOO_LARGE', 'bad-input'],
    ['DATA_TIMEOUT', 'timeout'],
    ['DATA_OFFLINE', 'offline'],
  ];
  const PG_CODES = {
    '42501': 'permission',
    '23505': 'request-pending',
    'PGRST116': 'not-found',
    'PGRST301': 'no-session',
    'PGRST302': 'no-session',
  };
  const AUTH_CODES = {
    'invalid_credentials': 'invalid-credential',
    'user_not_found': 'invalid-credential',
    'email_exists': 'email-in-use',
    'user_already_exists': 'email-in-use',
    'weak_password': 'weak-password',
    'email_not_confirmed': 'email-not-confirmed',
    'email_address_invalid': 'invalid-email',
    'over_request_rate_limit': 'rate-limited',
    'over_email_send_rate_limit': 'rate-limited',
    'over_sms_send_rate_limit': 'rate-limited',
    'session_not_found': 'no-session',
    'refresh_token_not_found': 'no-session',
    'refresh_token_already_used': 'no-session',
    'bad_jwt': 'no-session',
  };

  function mapSupabase(e) {
    const msg = String(e.message || '');
    for (const [name, code] of SQL_MESSAGES) {
      if (new RegExp('\\b' + name + '\\b').test(msg)) return code;
    }
    const raw = e.code ? String(e.code) : '';
    if (AUTH_CODES[raw]) return AUTH_CODES[raw];
    if (PG_CODES[raw]) return PG_CODES[raw];
    if (e.status === 429) return 'rate-limited';
    if (/JWT expired/i.test(msg)) return 'no-session';
    if (/Auth session missing/i.test(msg)) return 'no-session';
    if (/Invalid login credentials/i.test(msg)) return 'invalid-credential';
    if (/Failed to fetch|Load failed|NetworkError|network request failed|AuthRetryableFetchError/i.test(msg + ' ' + (e.name || ''))) return 'offline';
    if (e.name === 'AbortError') return 'timeout';
    return '';
  }

  function normalizeError(err) {
    if (err instanceof DataError) return err;
    const e = err || {};
    if (isTerminated(e)) return new DataError('terminated', e.message, err);
    if (SENTINELS[e.message]) return new DataError(SENTINELS[e.message], e.message, err);
    const sb = mapSupabase(e);
    if (sb) return new DataError(sb, e.message, err);
    const raw = e.code ? String(e.code) : '';
    if (MAPPED[raw]) return new DataError(MAPPED[raw], e.message, err);
    return new DataError(raw || 'unknown', e.message, err);
  }

  // Same readiness signal the pages use today: window._auth is set by
  // firebase-init.js, which then fires appDbReady. No timeout on purpose;
  // each page keeps its own stuck-loading UI.
  function ready() {
    return new Promise((resolve) => {
      if (window._auth || (window.SUPABASE_CONFIG && window.supabase)) { resolve(); return; }
      window.addEventListener('appDbReady', () => resolve(), { once: true });
    });
  }

  const platform = {
    leave(url) {
      if (typeof window._leave === 'function') return window._leave(url);
      location.assign(url);
    },
    isTerminated,
    leaving() { return !!window._leaving; },
  };

  // ---- Supabase ------------------------------------------------------------

  // snake_case -> camelCase keys (rows from the database, deep).
  function camelKey(k) { return String(k).replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase()); }
  function camel(v) {
    if (Array.isArray(v)) return v.map(camel);
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      const out = {};
      for (const k of Object.keys(v)) out[camelKey(k)] = camel(v[k]);
      return out;
    }
    return v;
  }

  // timestamptz comes back with an offset ("+00:00"); the pages compare ISO
  // strings, so normalise. Empty / invalid stays '' rather than throwing.
  function iso(x) {
    if (x === null || x === undefined || x === '') return '';
    const d = new Date(x);
    return isNaN(d.getTime()) ? '' : d.toISOString();
  }

  // localStorage can throw (private mode, blocked storage): fall back to memory.
  function makeStorage() {
    const mem = {};
    return {
      getItem(k) {
        try { return window.localStorage.getItem(k); } catch (e) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; }
      },
      setItem(k, v) {
        try { window.localStorage.setItem(k, v); } catch (e) { mem[k] = String(v); }
      },
      removeItem(k) {
        try { window.localStorage.removeItem(k); } catch (e) { delete mem[k]; }
      },
    };
  }

  const TIMEOUT_MS = 15000;
  const CHECK_IN_TIMEOUT_MS = 8000;

  function tagged(name, message) { const e = new Error(message); e.name = name; return e; }

  // fetch with a hard deadline. The abort surfaces as DATA_TIMEOUT, which the
  // client libraries pass through in their error message and normalizeError
  // turns into DataError('timeout'). Offline browsers throw a TypeError.
  function timedFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const ms = /\/rpc\/check_in(\?|$)/.test(url) ? CHECK_IN_TIMEOUT_MS : TIMEOUT_MS;
    const ctl = new AbortController();
    const outer = init && init.signal;
    if (outer) {
      if (outer.aborted) ctl.abort();
      else outer.addEventListener('abort', () => ctl.abort(), { once: true });
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, ms);
    return fetch(input, Object.assign({}, init, { signal: ctl.signal })).then(
      (res) => { clearTimeout(timer); return res; },
      (err) => {
        clearTimeout(timer);
        if (timedOut) throw tagged('DataTimeout', 'DATA_TIMEOUT');
        if (err && err.name === 'AbortError') throw err;
        throw tagged('DataOffline', 'DATA_OFFLINE: ' + (err && err.message ? err.message : 'network'));
      }
    );
  }

  let sbClient = null;
  function client() {
    if (sbClient) return sbClient;
    const cfg = window.SUPABASE_CONFIG;
    if (!cfg || !cfg.url || !window.supabase || typeof window.supabase.createClient !== 'function') {
      throw new DataError('offline', 'Supabase client is not loaded');
    }
    sbClient = window.supabase.createClient(cfg.url, cfg.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storage: makeStorage(),
        // The default lock uses navigator.locks and can hang a tab on old
        // phones; the pages never refresh from two tabs at once in a way
        // that matters.
        lock: (_name, _timeout, fn) => fn(),
      },
      global: { fetch: timedFetch },
    });
    return sbClient;
  }

  // Runs one rpc and returns its data, or throws DataError.
  async function rpc(name, args) {
    let res;
    try { res = await client().rpc(name, args || {}); } catch (e) { throw normalizeError(e); }
    if (res && res.error) throw normalizeError(res.error);
    return res ? res.data : null;
  }

  // One shared poller. fn runs one request at a time; it is paused while the
  // page is hidden and runs at once when the page returns. A failing fn
  // doubles the wait up to 60 s; the next success resets it. Each wait is
  // jittered by +-10% so many phones do not hit the server together.
  function makePoller(fn, intervalMs) {
    let timer = null, delay = intervalMs, inflight = false, stopped = true, suspended = false, listening = false;
    const active = () => !stopped && !suspended && !document.hidden;
    const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
    function schedule() {
      clear();
      if (!active()) return;
      timer = setTimeout(tick, delay * (0.9 + Math.random() * 0.2));
    }
    async function tick() {
      timer = null;
      if (!active() || inflight) return;
      inflight = true;
      try { await fn(); delay = intervalMs; } catch (e) { delay = Math.min(delay * 2, 60000); }
      inflight = false;
      schedule();
    }
    function wake() {
      if (stopped) return;
      suspended = false;
      if (!active() || inflight) return;
      clear();
      tick();
    }
    const onHide = () => { suspended = true; clear(); };
    const onVis = () => { if (document.hidden) clear(); else wake(); };
    function listen(on) {
      if (on === listening) return;
      listening = on;
      const f = on ? 'addEventListener' : 'removeEventListener';
      document[f]('visibilitychange', onVis);
      window[f]('pageshow', wake);
      window[f]('focus', wake);
      window[f]('pagehide', onHide);
    }
    return {
      start() { stopped = false; suspended = false; delay = intervalMs; listen(true); if (active()) tick(); },
      stop() { stopped = true; clear(); listen(false); },
      // Run now (a manual retry); no-op while a request is in flight.
      refresh() { if (!stopped && !inflight) { clear(); tick(); } },
    };
  }

  const INVITE_POLL_MS = 12000;

  const invite = {
    // Readable link name -> event id, or null when the name is not taken.
    async resolveSlug(slug) {
      const id = await rpc('resolve_slug', { p_slug: String(slug || '') });
      return id || null;
    },
    // The public view of an event, or null.
    async event(eventId) {
      const rows = await rpc('event_public', { p_event_id: eventId });
      const row = Array.isArray(rows) ? rows[0] : rows;
      return row ? camel(row) : null;
    },
    async submitRequest(eventId, reqId, name) {
      await rpc('submit_request', { p_event_id: eventId, p_req_id: reqId, p_name: name });
    },
    // { status, guestId, vip, name } or null (no such request).
    async getRequest(eventId, reqId) {
      const rows = await rpc('get_request', { p_event_id: eventId, p_req_id: reqId });
      const row = Array.isArray(rows) ? rows[0] : rows;
      return row ? camel(row) : null;
    },
    // Calls cb.onChange(request | null) after every answer and cb.onError(err)
    // on a failed one. Polls while the request is pending or rejected and
    // stops for good once it is approved with its barcode id.
    watchRequest(eventId, reqId, cb) {
      let poller = null, dead = false;
      poller = makePoller(async () => {
        let req;
        try { req = await invite.getRequest(eventId, reqId); } catch (e) {
          if (!dead && cb.onError) cb.onError(e);
          throw e;
        }
        if (dead) return;
        if (cb.onChange) cb.onChange(req);
        if (req && req.status === 'approved' && req.guestId) poller.stop();
      }, INVITE_POLL_MS);
      poller.start();
      return { stop: () => { dead = true; poller.stop(); }, refresh: () => poller.refresh() };
    },
  };

  window.Data = { DataError, normalizeError, ready, platform, client, camel, iso, makePoller, timedFetch, invite };
})();
