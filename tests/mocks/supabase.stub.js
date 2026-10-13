// In-memory stand-in for window.supabase (the UMD build of supabase-js).
// State lives in window.__fakeSupabase, seeded by seedFakeSupabase() in
// tests/helpers.js. It simulates the SERVER rules the pages depend on (the
// public functions of supabase/migrations) and the 1000-row max_rows cap on
// table reads. Errors have the shape PostgREST returns: { message, code }.
(function () {
  const S = () => window.__fakeSupabase;

  const wait = () => {
    const ms = S().latency || 0;
    return new Promise((r) => (ms ? setTimeout(r, ms) : Promise.resolve().then(r)));
  };

  function pgError(message, code) { return { message, code: code || 'P0001', details: null, hint: null }; }

  // Per-function failure injection: S().fail = { get_request: { error, times } }
  // where error is { message, code } or 'network' (a fetch failure) and times
  // is how many calls fail (default: all).
  function injected(name) {
    const f = S().fail && S().fail[name];
    if (!f) return null;
    if (f.times !== undefined) { if (f.times <= 0) return null; f.times--; }
    return f.error === 'network' ? pgError('TypeError: Failed to fetch', '') : f.error;
  }

  function guestCap(ev) {
    return ev.guest_limit != null ? ev.guest_limit : (ev.paid ? 1000000 : 5);
  }

  const FUNCS = {
    resolve_slug(a) {
      const id = (S().slugs || {})[a.p_slug];
      return id === undefined ? null : id;
    },
    event_public(a) {
      const ev = (S().events || {})[a.p_event_id];
      if (!ev) return [];
      return [{
        name: ev.name, type: ev.type === undefined ? null : ev.type, date: ev.date,
        venue: ev.venue === undefined ? null : ev.venue,
        maps_link: ev.maps_link === undefined ? null : ev.maps_link,
        theme: ev.theme === undefined ? null : ev.theme,
        welcome_message: ev.welcome_message === undefined ? null : ev.welcome_message,
      }];
    },
    submit_request(a) {
      const id = a.p_req_id;
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(id)) throw pgError('BAD_REQUEST_ID', '22023');
      const nm = String(a.p_name == null ? '' : a.p_name).trim();
      if (nm.length < 1 || nm.length > 100) throw pgError('BAD_NAME', '22023');
      const ev = (S().events || {})[a.p_event_id];
      if (!ev) throw pgError('EVENT_NOT_FOUND', 'P0002');
      const reqs = (S().requests = S().requests || {});
      const mine = (reqs[a.p_event_id] = reqs[a.p_event_id] || {});
      if (mine[id]) return null;
      const pending = Object.values(mine).filter((r) => r.status === 'pending').length;
      if (pending >= Math.min(Math.max(guestCap(ev), 50), 5000)) throw pgError('REQUESTS_FULL', 'P0001');
      mine[id] = { status: 'pending', guest_id: null, vip: false, name: nm };
      return null;
    },
    get_request(a) {
      const r = ((S().requests || {})[a.p_event_id] || {})[a.p_req_id];
      if (!r || String(a.p_req_id).length < 20) return [];
      return [{ status: r.status, guest_id: r.guest_id == null ? null : r.guest_id, vip: !!r.vip, name: r.name }];
    },
  };


  // ---- door scanner (supabase/migrations 0004, 0013) ------------------------
  // State: S().doors[eventId] = { pin, guests: [row], attempts: {uid: n}, locked, lastChange }
  //        S().sessions[eventId][uid] = pin the device proved
  //        S().owners[eventId] = owner uid; S().admins = [emails]
  // Guest rows: { id, name, scanned, scanned_at, vip, changed_at } like door_guests returns.
  // Counters are computed from the rows (the real triggers keep them equal).
  let lastMs = 0, micro = 0;
  function stamp() {
    const ms = Date.now();
    if (ms === lastMs) micro++; else { lastMs = ms; micro = 0; }
    return new Date(ms).toISOString().replace('Z', String(micro).padStart(3, '0') + '+00:00');
  }
  // microseconds since the epoch, for comparing the stub's and the client's timestamps
  function tsKey(x) {
    const m = String(x).match(/\.(\d+)/);
    const frac = m ? Number(m[1].padEnd(6, '0').slice(0, 6)) : 0;
    return Math.floor(Date.parse(String(x).replace(/\.\d+/, '')) / 1000) * 1e6 + frac;
  }
  const doorOf = (eid) => ((S().doors = S().doors || {})[eid]);
  const me = () => S().auth.user;
  function isAdminUser(u) { return !!u && !u.is_anonymous && (S().admins || []).includes(u.email); }
  function canDoor(eid) {
    const u = me();
    if (!u) return false;
    const d = doorOf(eid);
    if (!d) return false;
    const sess = ((S().sessions || {})[eid] || {})[u.id];
    if (d.pin && sess === d.pin) return true;
    if (!u.is_anonymous && (S().owners || {})[eid] === u.id) return true;
    return isAdminUser(u);
  }
  function needDoor(eid) { if (!canDoor(eid)) throw pgError('NO_SESSION', '42501'); }
  function touch(d) { d.lastChange = stamp(); }
  function counts(d) { return { guest_count: d.guests.length, scanned_count: d.guests.filter((g) => g.scanned).length }; }

  Object.assign(FUNCS, {
    start_scan_session(a) {
      const u = me();
      if (!u) throw pgError('NOT_SIGNED_IN', '28000');
      const d = doorOf(a.p_event_id);
      if (!d || !d.pin) return 'wrong';
      d.attempts = d.attempts || {};
      const sessions = (S().sessions = S().sessions || {});
      const mine = (sessions[a.p_event_id] = sessions[a.p_event_id] || {});
      if ((d.attempts[u.id] || 0) >= 10) return 'locked';
      if (d.budgetSpent && !mine[u.id]) return 'locked';
      if (a.p_pin && a.p_pin === d.pin) { d.attempts[u.id] = 0; mine[u.id] = d.pin; return 'ok'; }
      d.attempts[u.id] = (d.attempts[u.id] || 0) + 1;
      return 'wrong';
    },
    end_scan_session(a) {
      const u = me();
      const mine = ((S().sessions || {})[a.p_event_id]);
      if (u && mine) delete mine[u.id];
      return null;
    },
    scan_session_valid(a) {
      const u = me();
      const d = doorOf(a.p_event_id);
      return !!(u && d && d.pin && ((S().sessions || {})[a.p_event_id] || {})[u.id] === d.pin);
    },
    is_admin_me() { return isAdminUser(me()); },
    door_event(a) {
      needDoor(a.p_event_id);
      const d = doorOf(a.p_event_id);
      const ev = (S().events || {})[a.p_event_id] || {};
      const row = Object.assign({ name: ev.name || '', last_change: d.lastChange || null }, counts(d));
      const o = S().counterOverride;
      if (o && (o.times === undefined || o.times > 0)) { if (o.times !== undefined) o.times--; Object.assign(row, o.row); }
      return [row];
    },
    check_in(a) {
      const eid = a.p_event_id;
      if (!canDoor(eid)) return [{ outcome: 'no_session', guest_name: null, vip: null, scanned_at: null, scanned_count: null }];
      const d = doorOf(eid);
      const g = d.guests.find((x) => x.id === a.p_guest_id);
      if (!g) return [{ outcome: 'not_found', guest_name: null, vip: null, scanned_at: null, scanned_count: counts(d).scanned_count }];
      if (g.scanned) return [{ outcome: 'duplicate', guest_name: g.name, vip: g.vip, scanned_at: g.scanned_at, scanned_count: counts(d).scanned_count }];
      g.scanned = true; g.scanned_at = stamp(); g.changed_at = stamp(); touch(d);
      return [{ outcome: 'allowed', guest_name: g.name, vip: g.vip, scanned_at: g.scanned_at, scanned_count: counts(d).scanned_count }];
    },
    door_guests(a) {
      needDoor(a.p_event_id);
      const d = doorOf(a.p_event_id);
      const lim = Math.min(Math.max(a.p_limit == null ? 1000 : a.p_limit, 1), 1000);
      const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
      let rows;
      if (a.p_since == null) {
        rows = d.guests.slice().sort((x, y) => cmp(x.name, y.name) || cmp(x.id, y.id));
        if (a.p_after_id != null) rows = rows.filter((g) => cmp(g.name, a.p_after_name || '') > 0 || (g.name === (a.p_after_name || '') && cmp(g.id, a.p_after_id) > 0));
      } else {
        const since = tsKey(a.p_since);
        rows = d.guests.slice().sort((x, y) => (tsKey(x.changed_at) - tsKey(y.changed_at)) || cmp(x.id, y.id));
        rows = a.p_after_id == null
          ? rows.filter((g) => tsKey(g.changed_at) > since)
          : rows.filter((g) => tsKey(g.changed_at) > since || (tsKey(g.changed_at) === since && cmp(g.id, a.p_after_id) > 0));
      }
      return rows.slice(0, lim).map((g) => Object.assign({}, g));
    },
  });


  // ---- organizer app (supabase/migrations 0008, 0014) -----------------------
  // S().events[id] may carry owner_uid, owner_email, created_at, paid, guest_limit, guest_count, scanned_count, slug.
  // S().limits[uid] = { event_limit, event_count }; S().eventRequests = [{ id, uid, email, status, requested_at }];
  // S().users = [{ uid, email, created_at }].
  function needCustomer() {
    const u = me();
    if (!u || u.is_anonymous) throw pgError('NOT_ALLOWED', '42501');
    return u;
  }
  function needAdmin() { const u = me(); if (!isAdminUser(u)) throw pgError('NOT_ALLOWED', '42501'); return u; }
  const limitsOf = () => (S().limits = S().limits || {});
  const reqsOf = () => (S().eventRequests = S().eventRequests || []);
  const usersOf = () => (S().users = S().users || []);
  function evRow(id, e) {
    return {
      id, owner_uid: e.owner_uid || null, owner_email: e.owner_email || '', name: e.name || '', type: e.type || '', date: e.date || '',
      venue: e.venue || '', maps_link: e.maps_link || '', theme: e.theme || '', welcome_message: e.welcome_message || '',
      paid: !!e.paid, guest_limit: e.guest_limit == null ? null : e.guest_limit, guest_count: e.guest_count || 0,
      scanned_count: e.scanned_count || 0, slug: e.slug || null, slug_decided: !!e.slug_decided,
      created_at: e.created_at || '2026-01-01T00:00:00.000000+00:00',
    };
  }
  let seq = 0;
  Object.assign(FUNCS, {
    list_events(a) {
      const u = needCustomer();
      let lim = a.p_limit == null ? 1000 : a.p_limit;
      if (lim < 1) throw pgError('BAD_INPUT', '22023');
      lim = Math.min(lim, 1000);
      let rows = Object.entries(S().events || {}).map(([id, e]) => evRow(id, e)).filter((r) => isAdminUser(u) || r.owner_uid === u.id);
      rows.sort((x, y) => (tsKey(y.created_at) - tsKey(x.created_at)) || (x.id < y.id ? 1 : x.id > y.id ? -1 : 0));
      if (a.p_after_created != null) {
        const ac = tsKey(a.p_after_created);
        rows = rows.filter((r) => tsKey(r.created_at) < ac || (tsKey(r.created_at) === ac && r.id < (a.p_after_id == null ? '￿' : a.p_after_id)));
      }
      return rows.slice(0, lim);
    },
    my_account() {
      const u = needCustomer();
      const l = limitsOf()[u.id] || { event_limit: 1, event_count: 0 };
      const p = reqsOf().find((r) => r.uid === u.id && r.status === 'pending');
      return [{ event_limit: l.event_limit, event_count: l.event_count, pending_request: p ? p.id : null }];
    },
    create_event(a) {
      const u = needCustomer();
      if (!isAdminUser(u)) {
        const l = (limitsOf()[u.id] = limitsOf()[u.id] || { event_limit: 1, event_count: 0 });
        if (l.event_count >= l.event_limit) throw pgError('LIMIT_REACHED', 'P0001');
        l.event_count++;
      }
      const name = String(a.p_name == null ? '' : a.p_name).trim();
      if (name.length < 1 || name.length > 80) throw pgError('new row for relation "events" violates check constraint "events_name_check"', '23514');
      const id = 'ev' + (++seq) + Math.random().toString(36).slice(2, 8);
      const row = (S().events = S().events || {})[id] = {
        name, type: a.p_type, date: a.p_date, venue: a.p_venue, maps_link: a.p_maps_link, theme: a.p_theme,
        owner_uid: u.id, owner_email: u.email || '', paid: false, guest_count: 0, scanned_count: 0, created_at: stamp(),
      };
      // a page navigation wipes the fake server, so a test can ask to be told about every created event
      if (typeof window.__onCreateEvent === 'function') window.__onCreateEvent(JSON.stringify(Object.assign({ id }, row)));
      return id;
    },
    delete_event(a) {
      const u = needCustomer();
      const e = (S().events || {})[a.p_event_id];
      if (!e || !(e.owner_uid === u.id || isAdminUser(u))) throw pgError('NOT_ALLOWED', '42501');
      delete S().events[a.p_event_id];
      const l = limitsOf()[e.owner_uid];
      if (l) l.event_count = Math.max(l.event_count - 1, 0);
      return null;
    },
    bump_event_limit() {
      const u = needCustomer();
      const l = limitsOf()[u.id];
      if (!l) throw pgError('NO_LIMIT_ROW', 'P0002');
      if (l.event_limit >= 3) throw pgError('CEILING_REACHED', 'P0001');
      l.event_limit++;
      return l.event_limit;
    },
    request_extra_event() {
      const u = needCustomer();
      const have = reqsOf().find((r) => r.uid === u.id && r.status === 'pending');
      if (have) return [{ id: have.id, created: false }];
      const r = { id: 'rq-' + (++seq), uid: u.id, email: u.email || '', status: 'pending', requested_at: stamp() };
      reqsOf().push(r);
      return [{ id: r.id, created: true }];
    },
    admin_pending_requests() {
      needAdmin();
      return reqsOf().filter((r) => r.status === 'pending').slice(0, 500).map((r) => ({ id: r.id, uid: r.uid, email: r.email, requested_at: r.requested_at }));
    },
    admin_reject_event_request(a) {
      needAdmin();
      const r = reqsOf().find((x) => x.id === a.p_id);
      if (!r) throw pgError('REQUEST_NOT_FOUND', 'P0002');
      if (r.status !== 'pending') throw pgError('NOT_PENDING', 'P0001');
      r.status = 'rejected';
      return null;
    },
    admin_approve_event_request(a) {
      needAdmin();
      const r = reqsOf().find((x) => x.id === a.p_id);
      if (!r) throw pgError('REQUEST_NOT_FOUND', 'P0002');
      if (r.status !== 'pending') throw pgError('NOT_PENDING', 'P0001');
      const l = limitsOf()[r.uid];
      if (l) l.event_limit++; else limitsOf()[r.uid] = { event_limit: 2, event_count: 0 };
      r.status = 'approved';
      return null;
    },
    admin_activate_event(a) {
      needAdmin();
      if (a.p_limit == null || a.p_limit < 1 || a.p_limit > 2000) throw pgError('BAD_INPUT', '22023');
      const e = (S().events || {})[a.p_event_id];
      if (!e) throw pgError('EVENT_NOT_FOUND', 'P0002');
      e.paid = true; e.guest_limit = a.p_limit;
      return null;
    },
    admin_user_count() { needAdmin(); return usersOf().length; },
    admin_list_users(a) {
      needAdmin();
      let lim = a.p_limit == null ? 500 : a.p_limit;
      if (lim < 1) throw pgError('BAD_INPUT', '22023');
      lim = Math.min(lim, 1000);
      let rows = usersOf().slice().sort((x, y) => (tsKey(y.created_at) - tsKey(x.created_at)) || (x.uid < y.uid ? 1 : -1));
      if (a.p_after_created != null) {
        const ac = tsKey(a.p_after_created);
        rows = rows.filter((r) => tsKey(r.created_at) < ac || (tsKey(r.created_at) === ac && r.uid < (a.p_after_uid || '￿')));
      }
      return rows.slice(0, lim).map((r) => Object.assign({}, r));
    },
    admin_remove_user_record(a) {
      needAdmin();
      const i = usersOf().findIndex((r) => r.uid === a.p_uid);
      if (i >= 0) usersOf().splice(i, 1);
      return i >= 0;
    },
  });

  // Server-side actions a test performs "from another device or the dashboard".
  window.__srv = {
    stamp,
    door(eid) { return doorOf(eid); },
    addGuest(eid, g) {
      const d = doorOf(eid);
      d.guests.push(Object.assign({ scanned: false, scanned_at: null, vip: false, changed_at: stamp() }, g));
      touch(d);
    },
    checkIn(eid, id) {
      const d = doorOf(eid); const g = d.guests.find((x) => x.id === id);
      if (g && !g.scanned) { g.scanned = true; g.scanned_at = stamp(); g.changed_at = stamp(); touch(d); }
    },
    undo(eid, id) {
      const d = doorOf(eid); const g = d.guests.find((x) => x.id === id);
      if (g && g.scanned) { g.scanned = false; g.scanned_at = null; g.changed_at = stamp(); touch(d); }
    },
    rename(eid, id, name) {
      const d = doorOf(eid); const g = d.guests.find((x) => x.id === id);
      if (g) { g.name = name; g.changed_at = stamp(); touch(d); }
    },
    setVip(eid, id, vip) {
      const d = doorOf(eid); const g = d.guests.find((x) => x.id === id);
      if (g) { g.vip = vip; g.changed_at = stamp(); touch(d); }
    },
    removeGuest(eid, id) {
      const d = doorOf(eid); const i = d.guests.findIndex((x) => x.id === id);
      if (i >= 0) { d.guests.splice(i, 1); touch(d); }
    },
    // the organizer generates a new door code: every device's session stops matching
    setPin(eid, pin) { doorOf(eid).pin = pin; },
    // the sign-in disappears in another tab of this browser
    signOutElsewhere() { const A = S().auth; A.user = null; A.listeners.slice().forEach((fn) => fn('SIGNED_OUT', null)); },
    signInElsewhere(user) { const A = S().auth; A.user = user; A.listeners.slice().forEach((fn) => fn('SIGNED_IN', { user })); },
  };

  async function callRpc(name, args) {
    S().calls.push({ name, args: JSON.parse(JSON.stringify(args || {})) });
    await wait();
    const extra = S().rpcDelay && S().rpcDelay[name];
    if (extra) await new Promise((r) => setTimeout(r, extra));
    // S().holdRpc = { check_in: true } parks every call until a test releases it:
    // window.__fakeSupabase.held.shift()('ok' | 'fail')
    if (S().holdRpc && S().holdRpc[name]) {
      const mode = await new Promise((res) => { (S().held = S().held || []).push(res); });
      if (mode === 'fail') return { data: null, error: pgError('TypeError: Failed to fetch', '') };
    }
    const bad = injected(name);
    if (bad) return { data: null, error: bad };
    if ((S().denyRpc || []).includes(name)) return { data: null, error: pgError('permission denied for function ' + name, '42501') };
    const fn = FUNCS[name];
    if (!fn) return { data: null, error: pgError('function ' + name + ' not found', '42883') };
    try {
      const data = fn(args || {});
      const drop = S().dropReply && S().dropReply[name];
      if (drop && drop > 0) { S().dropReply[name] = drop - 1; return { data: null, error: pgError('TypeError: Failed to fetch', '') }; }
      return { data, error: null };
    } catch (e) { return { data: null, error: e }; }
  }

  // Table reads: select / insert / update / delete / eq / order / range / single.
  function table(name) {
    const st = { op: 'select', filters: [], order: null, range: null, single: false, maybe: false, payload: null };
    const rows = () => ((S().tables = S().tables || {})[name] = (S().tables[name] || []));
    const b = {
      select() { return b; },
      insert(p) { st.op = 'insert'; st.payload = p; return b; },
      update(p) { st.op = 'update'; st.payload = p; return b; },
      delete() { st.op = 'delete'; return b; },
      eq(k, v) { st.filters.push([k, v]); return b; },
      order(k, o) { st.order = [k, !(o && o.ascending === false)]; return b; },
      range(a, z) { st.range = [a, z]; return b; },
      single() { st.single = true; return b; },
      maybeSingle() { st.maybe = true; return b; },
      then(res, rej) { return run().then(res, rej); },
    };
    async function run() {
      S().calls.push({ name: 'from:' + name, args: { op: st.op, filters: st.filters, range: st.range } });
      await wait();
      const bad = injected('from:' + name);
      if (bad) return { data: null, error: bad };
      const all = rows();
      const match = (r) => st.filters.every(([k, v]) => r[k] === v);
      if (st.op === 'insert') {
        const list = Array.isArray(st.payload) ? st.payload : [st.payload];
        list.forEach((r) => all.push(Object.assign({}, r)));
        return { data: null, error: null };
      }
      if (st.op === 'update') { all.filter(match).forEach((r) => Object.assign(r, st.payload)); return { data: null, error: null }; }
      if (st.op === 'delete') {
        for (let i = all.length - 1; i >= 0; i--) if (match(all[i])) all.splice(i, 1);
        return { data: null, error: null };
      }
      let out = all.filter(match).map((r) => Object.assign({}, r));
      if (st.order) {
        const [k, asc] = st.order;
        out.sort((x, y) => (x[k] < y[k] ? -1 : x[k] > y[k] ? 1 : 0) * (asc ? 1 : -1));
      }
      const cap = S().maxRows || 1000;
      const from = st.range ? st.range[0] : 0;
      const to = st.range ? Math.min(st.range[1], from + cap - 1) : from + cap - 1;
      out = out.slice(from, to + 1);
      if (st.single || st.maybe) {
        if (out.length === 1) return { data: out[0], error: null };
        if (out.length === 0 && st.maybe) return { data: null, error: null };
        return { data: null, error: pgError('JSON object requested, multiple (or no) rows returned', 'PGRST116') };
      }
      return { data: out, error: null };
    }
    return b;
  }

  function makeAuth() {
    const A = () => S().auth;
    const emit = (event) => A().listeners.slice().forEach((fn) => fn(event, A().user ? { user: A().user } : null));
    const authErr = (code, message, status) => ({ code, message, status: status || 400, name: 'AuthApiError' });
    return {
      async getSession() { await wait(); return { data: { session: A().user ? { user: A().user } : null }, error: null }; },
      async getUser() { await wait(); return A().user ? { data: { user: A().user }, error: null } : { data: { user: null }, error: authErr('session_not_found', 'Auth session missing!') }; },
      onAuthStateChange(fn) {
        A().listeners.push(fn);
        Promise.resolve().then(() => fn('INITIAL_SESSION', A().user ? { user: A().user } : null));
        return { data: { subscription: { unsubscribe() { A().listeners = A().listeners.filter((f) => f !== fn); } } } };
      },
      async signInAnonymously() {
        A().anonCalls = (A().anonCalls || 0) + 1;
        if (A().signInDelay) await new Promise((r) => setTimeout(r, A().signInDelay));
        await wait();
        if (A().alwaysSignInError) return { data: { user: null, session: null }, error: A().alwaysSignInError };
        A().user = { id: A().nextAnonUid || 'anon-' + Math.random().toString(36).slice(2, 8), is_anonymous: true, email: null };
        emit('SIGNED_IN');
        return { data: { user: A().user, session: { user: A().user } }, error: null };
      },
      async signInWithPassword({ email, password }) {
        await wait();
        if (A().nextSignInError) { const e = A().nextSignInError; A().nextSignInError = null; return { data: { user: null, session: null }, error: e }; }
        const acct = (A().accounts || {})[email];
        if (!acct || acct.password !== password) return { data: { user: null, session: null }, error: authErr('invalid_credentials', 'Invalid login credentials') };
        A().user = { id: acct.id, email, is_anonymous: false };
        emit('SIGNED_IN');
        return { data: { user: A().user, session: { user: A().user } }, error: null };
      },
      async signUp({ email, password, options }) {
        await wait();
        A().signUpCalls = (A().signUpCalls || []).concat([{ email, redirectTo: options && options.emailRedirectTo }]);
        if (A().nextSignUpError) { const e = A().nextSignUpError; A().nextSignUpError = null; return { data: { user: null, session: null }, error: e }; }
        A().accounts = A().accounts || {};
        const exists = !!A().accounts[email];
        if (exists && !A().confirmEmail) return { data: { user: null, session: null }, error: authErr('user_already_exists', 'User already registered') };
        // Confirm email ON: an address that is already registered answers like a new one but with no identities
        if (exists) return { data: { user: { id: A().accounts[email].id, email, identities: [] }, session: null }, error: null };
        if (String(password).length < 6) return { data: { user: null, session: null }, error: authErr('weak_password', 'Password should be at least 6 characters.') };
        const id = 'u-' + Object.keys(A().accounts).length;
        A().accounts[email] = { id, password, confirmed: !A().confirmEmail };
        (S().users = S().users || []).push({ uid: id, email, created_at: stamp() });
        if (A().confirmEmail) return { data: { user: { id, email, is_anonymous: false, identities: [{}] }, session: null }, error: null };
        A().user = { id, email, is_anonymous: false };
        emit('SIGNED_IN');
        return { data: { user: A().user, session: { user: A().user } }, error: null };
      },
      async resend({ email }) {
        await wait();
        A().resendCalls = (A().resendCalls || []).concat([email]);
        return { data: {}, error: A().nextResendError || null };
      },
      // the reset link: tokens 'good-access' / 'good-hash' open a session for A().recoveryUser, anything else is a dead link
      async setSession({ access_token }) {
        await wait();
        if (A().networkDown) return { data: { user: null, session: null }, error: { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 } };
        if (access_token !== 'good-access' || !A().recoveryUser) return { data: { user: null, session: null }, error: authErr('bad_jwt', 'invalid JWT', 401) };
        A().user = Object.assign({ is_anonymous: false }, A().recoveryUser);
        A().recoverySessions = (A().recoverySessions || 0) + 1;
        emit('SIGNED_IN');
        return { data: { user: A().user, session: { user: A().user } }, error: null };
      },
      async verifyOtp({ token_hash, type }) {
        await wait();
        A().verifyCalls = (A().verifyCalls || []).concat([type]);
        if (token_hash !== 'good-hash' || !A().recoveryUser) return { data: { user: null, session: null }, error: authErr('otp_expired', 'Email link is invalid or has expired', 403) };
        A().user = Object.assign({ is_anonymous: false }, A().recoveryUser);
        emit('SIGNED_IN');
        return { data: { user: A().user, session: { user: A().user } }, error: null };
      },
      async updateUser({ password }) {
        await wait();
        if (!A().user) return { data: { user: null }, error: authErr('session_not_found', 'Auth session missing!', 401) };
        if (A().nextUpdateError) { const e = A().nextUpdateError; A().nextUpdateError = null; return { data: { user: null }, error: e }; }
        if (String(password).length < 6) return { data: { user: null }, error: authErr('weak_password', 'Password should be at least 6 characters.', 422) };
        const acct = (A().accounts || {})[A().user.email];
        if (acct && acct.password === password) return { data: { user: null }, error: authErr('same_password', 'New password should be different from the old password.', 422) };
        if (acct) acct.password = password;
        A().passwordUpdates = (A().passwordUpdates || 0) + 1;
        return { data: { user: A().user }, error: null };
      },
      async signOut(opts) { A().signOutCalls = (A().signOutCalls || 0) + 1; A().lastSignOutArgs = opts || null; await wait(); A().user = null; emit('SIGNED_OUT'); return { error: null }; },
      async refreshSession() {
        await wait();
        A().refreshCalls = (A().refreshCalls || 0) + 1;
        if (A().refreshNetworkFails) return { data: { user: null, session: null }, error: { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 } };
        if (A().refreshFailCode) return { data: { user: null, session: null }, error: authErr(A().refreshFailCode, 'refresh failed: ' + A().refreshFailCode) };
        if (!A().user || A().refreshFails) return { data: { user: null, session: null }, error: authErr('refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found') };
        return { data: { user: A().user, session: { user: A().user } }, error: null };
      },
      async resetPasswordForEmail(email, opts) {
        await wait();
        A().resetCalls = (A().resetCalls || []).concat([{ email, redirectTo: opts && opts.redirectTo }]);
        return { data: {}, error: A().nextResetError || null };
      },
    };
  }

  window.supabase = {
    createClient(url, key, opts) {
      const s = S();
      s.createArgs = s.createArgs || [];
      s.createArgs.push({ url, key, opts });
      return {
        rpc: callRpc,
        from: table,
        auth: makeAuth(),
      };
    },
  };
})();
