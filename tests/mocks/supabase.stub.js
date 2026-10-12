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

  async function callRpc(name, args) {
    S().calls.push({ name, args: JSON.parse(JSON.stringify(args || {})) });
    await wait();
    const bad = injected(name);
    if (bad) return { data: null, error: bad };
    if ((S().denyRpc || []).includes(name)) return { data: null, error: pgError('permission denied for function ' + name, '42501') };
    const fn = FUNCS[name];
    if (!fn) return { data: null, error: pgError('function ' + name + ' not found', '42883') };
    try { return { data: fn(args || {}), error: null }; } catch (e) { return { data: null, error: e }; }
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
        await wait();
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
      async signUp({ email, password }) {
        await wait();
        A().accounts = A().accounts || {};
        if (A().accounts[email]) return { data: { user: null, session: null }, error: authErr('user_already_exists', 'User already registered') };
        if (String(password).length < 6) return { data: { user: null, session: null }, error: authErr('weak_password', 'Password should be at least 6 characters.') };
        A().accounts[email] = { id: 'u-' + Object.keys(A().accounts).length, password };
        A().user = { id: A().accounts[email].id, email, is_anonymous: false };
        emit('SIGNED_IN');
        return { data: { user: A().user, session: { user: A().user } }, error: null };
      },
      async signOut() { await wait(); A().user = null; emit('SIGNED_OUT'); return { error: null }; },
      async resetPasswordForEmail() { await wait(); return { data: {}, error: A().nextResetError || null }; },
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
