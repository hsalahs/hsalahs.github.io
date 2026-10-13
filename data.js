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
  const SQL_RES = SQL_MESSAGES.map(([name, code]) => [new RegExp('\\b' + name + '\\b'), code]);
  const PG_CODES = {
    '42501': 'permission',
    '23514': 'bad-input',
    '22023': 'bad-input',
    'PGRST116': 'not-found',
    'PGRST301': 'no-session',
    'PGRST302': 'no-session',
    'PGRST303': 'no-session',
  };
  const AUTH_CODES = {
    'invalid_credentials': 'invalid-credential',
    'user_not_found': 'invalid-credential',
    'email_exists': 'email-in-use',
    'user_already_exists': 'email-in-use',
    'weak_password': 'weak-password',
    'email_not_confirmed': 'email-not-confirmed',
    'same_password': 'same-password',
    'otp_expired': 'link-expired',
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
    for (const [re, code] of SQL_RES) {
      if (re.test(msg)) return code;
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
    if (typeof fetch !== 'function') return Promise.reject(new DataError('unsupported', 'fetch is not available'));
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const ms = /\/rpc\/check_in(\?|$)/.test(url) ? CHECK_IN_TIMEOUT_MS : TIMEOUT_MS;
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const outer = init && init.signal;
    if (ctl && outer) {
      if (outer.aborted) ctl.abort();
      else outer.addEventListener('abort', () => ctl.abort(), { once: true });
    }
    let timedOut = false;
    let timer = null;
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        if (ctl) ctl.abort();
        reject(tagged('DataTimeout', 'DATA_TIMEOUT'));
      }, ms);
    });
    const opts = ctl ? Object.assign({}, init, { signal: ctl.signal }) : init;
    const req = fetch(input, opts).then(
      (res) => { clearTimeout(timer); return res; },
      (err) => {
        clearTimeout(timer);
        if (timedOut) throw tagged('DataTimeout', 'DATA_TIMEOUT');
        if (err && err.name === 'AbortError') throw err;
        throw tagged('DataOffline', 'DATA_OFFLINE: ' + (err && err.message ? err.message : 'network'));
      }
    );
    req.catch(() => {});
    deadline.catch(() => {});
    return Promise.race([req, deadline]);
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
    // on a failed one. Keeps polling (also after approval, so a VIP change
    // shows live) until stop(), pagehide, or the request is gone (null).
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
        if (!req) { dead = true; poller.stop(); }
      }, INVITE_POLL_MS);
      poller.start();
      return { stop: () => { dead = true; poller.stop(); }, refresh: () => poller.refresh() };
    },
  };

  // ---- Auth (the door scanner's part) --------------------------------------

  function normUser(u) {
    return u ? { uid: u.id, email: u.email || '', isAnonymous: !!u.is_anonymous } : null;
  }

  async function authCall(fn) {
    let res;
    try { res = await fn(); } catch (e) { throw normalizeError(e); }
    if (res && res.error) throw normalizeError(res.error);
    return res ? res.data : null;
  }

  const auth = {
    // The signed-in user restored from this browser, or null. A stored session
    // that can no longer be refreshed reads as signed out.
    async current() {
      try {
        const res = await client().auth.getSession();
        return normUser(res && res.data && res.data.session ? res.data.session.user : null);
      } catch (e) { return null; }
    },
    // cb(user | null, event) on every change, also from another tab of this
    // browser. Returns the unsubscribe function.
    onChange(cb) {
      const res = client().auth.onAuthStateChange((event, session) => { cb(normUser(session ? session.user : null), event); });
      const sub = res && res.data && res.data.subscription;
      return () => { try { if (sub) sub.unsubscribe(); } catch (e) {} };
    },
    async signInAnon() {
      const d = await authCall(() => client().auth.signInAnonymously());
      return normUser(d && d.user);
    },
    async signInWithPassword(email, password) {
      const d = await authCall(() => client().auth.signInWithPassword({ email, password }));
      return normUser(d && d.user);
    },
    async signOut() {
      await authCall(() => client().auth.signOut());
    },
    async isAdmin() {
      return (await rpc('is_admin_me')) === true;
    },
    // { user, confirmed }. With «Confirm email» ON there is no session yet
    // (confirmed false); an address that is already registered comes back as a
    // user with no identities, which is reported as 'email-in-use'.
    async signUp(email, password, redirectTo) {
      const d = await authCall(() => client().auth.signUp({ email, password, options: redirectTo ? { emailRedirectTo: redirectTo } : {} }));
      const u = d && d.user;
      if (!u || (Array.isArray(u.identities) && u.identities.length === 0)) throw new DataError('email-in-use', 'email already registered');
      return { user: normUser(u), confirmed: !!(d && d.session) };
    },
    async resend(email, redirectTo) {
      await authCall(() => client().auth.resend({ type: 'signup', email, options: redirectTo ? { emailRedirectTo: redirectTo } : {} }));
    },
    async resetPassword(email, redirectTo) {
      await authCall(() => client().auth.resetPasswordForEmail(email, redirectTo ? { redirectTo } : {}));
    },
    async updatePassword(newPassword) {
      await authCall(() => client().auth.updateUser({ password: newPassword }));
    },
    // The reset e-mail link opens the app page with the tokens in the URL
    // (#access_token=...&refresh_token=...&type=recovery, or ?token_hash=...&type=recovery,
    // or #error_code=otp_expired for a used / old link). Call it ONCE on the app
    // page before anything else (the sign-up confirmation link comes back the same
    // way with type=signup: kind 'signup', the session is simply opened).
    // null = this is not such a link (nothing is touched); { user, kind } = the session is open; { error } = the link is
    // no good ('link-expired' or 'offline'). The tokens are cleared from the
    // address bar at once and never logged.
    async recoveryFromUrl() {
      const h = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
      const q = new URLSearchParams(String(location.search || ''));
      const type = h.get('type') || q.get('type');
      const failed = h.get('error') || h.get('error_code') || q.get('error_code');
      const access = h.get('access_token'), refresh = h.get('refresh_token'), hashTok = q.get('token_hash');
      const isRecovery = type === 'recovery' || type === 'signup' || (failed && /recovery|otp_expired|access_denied/i.test(failed + ' ' + (h.get('error_code') || '')));
      if (!isRecovery) return null;
      try {
        const keep = new URLSearchParams(q);
        ['token_hash', 'type', 'error', 'error_code', 'error_description'].forEach((k) => keep.delete(k));
        const qs = keep.toString();
        history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
      } catch (e) {}
      if (failed) return { error: 'link-expired' };
      try {
        let res;
        if (access && refresh) res = await client().auth.setSession({ access_token: access, refresh_token: refresh });
        else if (hashTok) res = await client().auth.verifyOtp({ token_hash: hashTok, type: type === 'signup' ? 'signup' : 'recovery' });
        else return { error: 'link-expired' };
        if (res && res.error) {
          const code = normalizeError(res.error).code;
          return { error: code === 'offline' ? 'offline' : 'link-expired' };
        }
        const user = res && res.data && res.data.user;
        return user ? { user: normUser(user), kind: type === 'signup' ? 'signup' : 'recovery' } : { error: 'link-expired' };
      } catch (e) {
        return { error: normalizeError(e).code === 'offline' ? 'offline' : 'link-expired' };
      }
    },
  };

  // ---- Organizer's events, account and the admin screens (app.html) -----------

  function eventRow(r) {
    const e = camel(r);
    e.slug = e.slug || '';
    e.createdAt = iso(e.createdAt);
    return e;
  }

  const EVENT_PAGE = 1000;   // list_events is capped at 1000 rows per call

  const events = {
    // Every event of the signed-in customer (the admin: every event), newest first.
    async list() {
      const out = [];
      let afterCreated = null, afterId = null;
      for (let pages = 0; pages < 200; pages++) {
        const page = await rpc('list_events', { p_after_created: afterCreated, p_after_id: afterId, p_limit: EVENT_PAGE });
        const list = Array.isArray(page) ? page : [];
        list.forEach((r) => out.push(eventRow(r)));
        if (list.length < EVENT_PAGE) break;
        const last = list[list.length - 1];
        afterCreated = last.created_at; afterId = last.id;
      }
      return out;
    },
    // Returns the new event id. Errors: 'limit-reached', 'permission', 'bad-input'.
    async create(ev) {
      return rpc('create_event', {
        p_name: ev.name, p_type: ev.type || '', p_date: ev.date || '', p_venue: ev.venue || '',
        p_maps_link: ev.mapsLink || '', p_theme: ev.theme || '',
      });
    },
    async remove(eventId) {
      await rpc('delete_event', { p_event_id: eventId });
    },
  };

  const account = {
    // { eventLimit, eventCount, pendingRequest (id | null) }
    async get() {
      const row = firstRow(await rpc('my_account')) || {};
      return { eventLimit: row.event_limit || 1, eventCount: row.event_count || 0, pendingRequest: row.pending_request || null };
    },
    // The customer's own +1 on the limit; returns the new limit.
    async bumpLimit() { return rpc('bump_event_limit'); },
    // { id, created }: created is false when a request was already waiting.
    async requestExtraEvent() {
      const row = firstRow(await rpc('request_extra_event')) || {};
      return { id: row.id || null, created: row.created === true };
    },
  };

  const admin = {
    async requests() {
      const rows = await rpc('admin_pending_requests');
      return (Array.isArray(rows) ? rows : []).map((r) => ({ id: r.id, uid: r.uid, email: r.email || '', requestedAt: iso(r.requested_at) }));
    },
    async approveRequest(id) { await rpc('admin_approve_event_request', { p_id: id }); },
    async rejectRequest(id) { await rpc('admin_reject_event_request', { p_id: id }); },
    async activateEvent(eventId, limit) { await rpc('admin_activate_event', { p_event_id: eventId, p_limit: limit }); },
    async accountsCount() { return (await rpc('admin_user_count')) || 0; },
    // Every account, newest first, paged.
    async accounts() {
      const out = [];
      let afterCreated = null, afterUid = null;
      for (let pages = 0; pages < 200; pages++) {
        const page = await rpc('admin_list_users', { p_after_created: afterCreated, p_after_uid: afterUid, p_limit: 1000 });
        const list = Array.isArray(page) ? page : [];
        list.forEach((r) => out.push({ uid: r.uid, email: r.email || '', createdAt: iso(r.created_at) }));
        if (list.length < 1000) break;
        const last = list[list.length - 1];
        afterCreated = last.created_at; afterUid = last.uid;
      }
      return out;
    },
    // Takes the account off the admin's list only (the sign-in and events stay).
    async removeAccountRecord(uid) { return (await rpc('admin_remove_user_record', { p_uid: uid })) === true; },
  };

  // ---- Door scanner ---------------------------------------------------------

  const SCAN_COUNTER_MS = 4000;
  const SCAN_NAMES_MS = 10000;
  const SCAN_FULL_MS = 60000;
  const GUEST_PAGE = 1000;       // the server caps a response at 1000 rows
  const CURSOR_MARGIN_MS = 60000;  // commit order vs changed_at, see supabase/README.md

  // The sign-in itself is no longer good (JWT expired for good, session gone,
  // user deleted). A plain NO_SESSION (the door code changed) is a different
  // thing: the identity is fine, only the door session is refused.
  function isAuthFailure(e) {
    return !!e && e.code === 'no-session' && !/\bNO_SESSION\b/.test(e.message || '');
  }

  // Only these refresh errors mean the stored sign-in is really dead; a
  // network failure (AuthRetryableFetchError, a thrown fetch error) must not
  // cost the device its identity and door session.
  const DEAD_TOKEN = /refresh_token_not_found|refresh_token_already_used|session_not_found|bad_jwt|user_not_found|invalid_grant|session missing|invalid refresh token/i;
  function deadToken(err) {
    return !!err && (DEAD_TOKEN.test(String(err.code || '')) || DEAD_TOKEN.test(String(err.message || '')));
  }

  // First try to refresh the token (a request can race the automatic refresh).
  // 'refreshed': it worked. 'offline': the refresh could not reach the server,
  // the identity is kept. 'reset': the token is really dead, so the identity is
  // dropped and the device signs in anonymously again (the code screen can then
  // work). Calls that fail at the same time share one healing.
  let healing = null;
  function healIdentity() {
    if (healing) return healing;
    healing = (async () => {
      let err = null;
      try {
        const r = await client().auth.refreshSession();
        if (r && !r.error && r.data && r.data.session) return 'refreshed';
        err = (r && r.error) || new Error('session missing');   // nothing stored to refresh = a dead sign-in
      } catch (e) { err = e; }
      if (!deadToken(err)) return 'offline';
      try { await client().auth.signOut({ scope: 'local' }); } catch (e) {}
      try { await client().auth.signInAnonymously(); } catch (e) {}
      return 'reset';
    })().finally(() => { healing = null; });
    return healing;
  }

  // One door rpc. An auth failure heals the identity; reads then run once more
  // (nothing was executed). A write (retry:false) is never repeated: after a
  // successful refresh it fails like a network error and the supervisor
  // scans again.
  async function scanRpc(name, args, retry) {
    try { return await rpc(name, args); } catch (e) {
      if (!isAuthFailure(e)) throw e;
      const how = await healIdentity();
      if (how === 'offline') throw new DataError('offline', e.message, e.cause || e);
      if (how === 'refreshed') {
        if (retry === false) throw new DataError('offline', e.message, e.cause || e);
        try { return await rpc(name, args); } catch (e2) {
          if (!isAuthFailure(e2)) throw e2;
          const again = await healIdentity();
          throw new DataError(again === 'reset' ? 'auth-lost' : 'offline', e2.message, e2.cause || e2);
        }
      }
      throw new DataError('auth-lost', e.message, e.cause || e);
    }
  }

  function firstRow(d) { return Array.isArray(d) ? d[0] : d; }

  function guestRow(r) {
    return { id: r.id, name: r.name, scanned: !!r.scanned, scannedAt: iso(r.scanned_at), vip: !!r.vip, changedAt: r.changed_at || '' };
  }

  // Every row of door_guests, paged until a page comes back short. since = null:
  // the whole list (keyset on name, id); since = ISO: only guests changed after
  // it (keyset on changed_at, id). Rows are merged by id, so a row that moves
  // between pages while the loop runs is kept once. cursor = the newest
  // changed_at minus one minute (never earlier than since): pass it back as the
  // next since. A page can only miss a row committed more than a minute after
  // its changed_at.
  async function scanGuests(eventId, sinceIso) {
    const byId = new Map();
    let since = sinceIso || null, afterName = null, afterId = null;
    for (let pages = 0; pages < 500; pages++) {
      const page = await scanRpc('door_guests', {
        p_event_id: eventId, p_since: since, p_after_name: afterName, p_after_id: afterId, p_limit: GUEST_PAGE,
      });
      const list = Array.isArray(page) ? page : [];
      list.forEach((r) => { byId.set(r.id, guestRow(r)); });
      if (list.length < GUEST_PAGE) break;
      const last = list[list.length - 1];
      if (sinceIso) { since = last.changed_at; afterId = last.id; } else { afterName = last.name; afterId = last.id; }
    }
    const rows = Array.from(byId.values());
    let maxMs = 0;
    rows.forEach((r) => { const t = new Date(r.changedAt).getTime(); if (t > maxMs) maxMs = t; });
    let cursor = sinceIso || null;
    if (maxMs) {
      const c = maxMs - CURSOR_MARGIN_MS;
      const floor = sinceIso ? new Date(sinceIso).getTime() : 0;
      cursor = new Date(Math.max(c, floor)).toISOString();
    }
    return { rows, cursor, full: !sinceIso };
  }

  const scan = {
    // 'ok' | 'wrong' | 'locked'
    async start(eventId, pin) {
      const r = await scanRpc('start_scan_session', { p_event_id: eventId, p_pin: String(pin == null ? '' : pin) });
      if (r === 'ok' || r === 'wrong' || r === 'locked') return r;
      throw new DataError('unknown', 'start_scan_session returned ' + r);
    },
    // Is this device's door session still good?
    async valid(eventId) {
      return (await scanRpc('scan_session_valid', { p_event_id: eventId })) === true;
    },
    async end(eventId) {
      await scanRpc('end_scan_session', { p_event_id: eventId });
    },
    // The scanner header numbers; null when the event is gone. lastChange moves
    // on every guest insert / delete / check-in / undo / rename / VIP edit.
    async event(eventId) {
      const row = firstRow(await scanRpc('door_event', { p_event_id: eventId }));
      if (!row) return null;
      return { name: row.name, guestCount: row.guest_count || 0, scannedCount: row.scanned_count || 0, lastChange: row.last_change || '' };
    },
    // One check-in. No automatic retry: if the answer is lost the guard at the
    // door scans again and the server answers 'duplicate'.
    // outcome: 'allowed' | 'duplicate' | 'not_found' | 'no_session'
    async checkIn(eventId, guestId) {
      const row = firstRow(await scanRpc('check_in', { p_event_id: eventId, p_guest_id: guestId }, false));
      const o = row && row.outcome;
      if (o !== 'allowed' && o !== 'duplicate' && o !== 'not_found' && o !== 'no_session') throw new DataError('unknown', 'check_in returned ' + o);
      return {
        outcome: o,
        guestName: row.guest_name || '',
        vip: !!row.vip,
        scannedAt: iso(row.scanned_at),
        scannedCount: typeof row.scanned_count === 'number' ? row.scanned_count : null,
      };
    },
    guests: scanGuests,
    // Live numbers and names. onCounter(event) every 4 s; the names are read
    // every 10 s but only when lastChange moved (as a delta from the cursor),
    // plus a full read every 60 s (that is what notices deleted guests).
    // Both pause while the page is hidden and run at once when it returns.
    // opts.since = cursor of the list the page already shows (null = none),
    // opts.lastChange = the lastChange that list matches (null = unknown, so
    // the first change check reads a delta). onGuests({ rows, cursor, full,
    // lastChange }); onError(err, 'counter' | 'names') for a failed poll (the poller backs off).
    watch(eventId, opts) {
      const o = opts || {};
      let cursor = o.since || null;
      let seen = o.lastChange === undefined ? null : o.lastChange;
      let latest;
      let lastFullAt = Date.now();
      let stopped = false;
      const fail = (e, kind) => { if (!stopped && o.onError) o.onError(e, kind); throw e; };
      const counter = makePoller(async () => {
        let ev;
        try { ev = await scan.event(eventId); } catch (e) { fail(e, 'counter'); }
        if (stopped || !ev) return;
        latest = ev.lastChange;
        if (o.onCounter) o.onCounter(ev);
      }, SCAN_COUNTER_MS);
      const names = makePoller(async () => {
        const due = Date.now() - lastFullAt >= SCAN_FULL_MS;
        if (!due && (latest === undefined || latest === seen)) return;
        const full = due || !cursor;
        const at = latest;
        let res;
        try { res = await scanGuests(eventId, full ? null : cursor); } catch (e) { fail(e, 'names'); }
        if (stopped) return;
        cursor = res.cursor;
        if (full) lastFullAt = Date.now();
        seen = at;
        if (o.onGuests) o.onGuests({ rows: res.rows, cursor: res.cursor, full: res.full, lastChange: at });
      }, SCAN_NAMES_MS);
      counter.start();
      names.start();
      return {
        stop() { stopped = true; counter.stop(); names.stop(); },
        refresh() { counter.refresh(); },
      };
    },
  };

  window.Data = { DataError, normalizeError, ready, platform, client, camel, iso, makePoller, timedFetch, invite, auth, scan, events, account, admin };
})();
