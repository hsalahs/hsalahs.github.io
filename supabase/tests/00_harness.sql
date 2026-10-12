-- Test harness, prepended to every test file by run-staging.mjs.
-- Everything runs in one transaction that is never committed (the request ends
-- with it open, which rolls back), so tests leave no data behind.
-- t_ok(name, sql, role, uid, anon)    passes when sql runs without error
-- t_fail(name, sql, role, uid, anon)  passes when sql raises an error
-- t_eq(name, sql, expected, role, uid, anon)  passes when the first column of the first row, as text, equals expected
-- role: 'postgres' | 'authenticated' | 'anon'. A test file ends with:
--   select * from pg_temp.report();   (always one row: total checks + failures json)
begin;
create temp table results (name text, pass boolean, detail text);

-- fixture ids: {A} owner, {B} other owner, {D} door device (anonymous), {ADM} admin
create function pg_temp.uid(k text) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-0000-0000000000' || case k when 'A' then 'a1' when 'B' then 'b2' when 'D' then 'd3' when 'ADM' then 'ad' end)::uuid;
$$;
create function pg_temp.fx(q text) returns text language sql immutable as $$
  select replace(replace(replace(replace(q, '{A}', pg_temp.uid('A')::text), '{B}', pg_temp.uid('B')::text), '{D}', pg_temp.uid('D')::text), '{ADM}', pg_temp.uid('ADM')::text);
$$;

create function pg_temp.as_role(p_role text, p_uid uuid, p_anon boolean) returns void
language plpgsql as $$
begin
  if p_role = 'postgres' or p_role is null then
    perform set_config('request.jwt.claims', '', true);
    execute 'reset role';
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', p_uid, 'role', p_role, 'is_anonymous', coalesce(p_anon, false))::text, true);
    execute 'set local role ' || quote_ident(p_role);
  end if;
end $$;

create function pg_temp.t_ok(p_name text, p_sql text, p_role text default 'postgres',
  p_uid uuid default null, p_anon boolean default false) returns void
language plpgsql as $$
declare err text;
begin
  begin
    perform pg_temp.as_role(p_role, p_uid, p_anon);
    execute pg_temp.fx(p_sql);
    execute 'reset role';
    insert into results values (p_name, true, null);
  exception when others then
    get stacked diagnostics err = message_text;
    execute 'reset role';
    insert into results values (p_name, false, 'unexpected error: ' || err);
  end;
end $$;

create function pg_temp.t_fail(p_name text, p_sql text, p_role text default 'postgres',
  p_uid uuid default null, p_anon boolean default false) returns void
language plpgsql as $$
declare err text; succeeded boolean := false;
begin
  begin
    perform pg_temp.as_role(p_role, p_uid, p_anon);
    execute pg_temp.fx(p_sql);
    succeeded := true;
    raise exception 'rollback_marker';  -- undo whatever the statement did
  exception when others then
    get stacked diagnostics err = message_text;
  end;
  execute 'reset role';
  if succeeded then
    insert into results values (p_name, false, 'expected an error but it succeeded');
  else
    insert into results values (p_name, true, err);
  end if;
end $$;

create function pg_temp.t_eq(p_name text, p_sql text, p_expected text, p_role text default 'postgres',
  p_uid uuid default null, p_anon boolean default false) returns void
language plpgsql as $$
declare got text;
begin
  begin
    perform pg_temp.as_role(p_role, p_uid, p_anon);
    execute pg_temp.fx(p_sql) into got;
  exception when others then
    got := 'ERROR: ' || sqlerrm;
  end;
  execute 'reset role';
  insert into results values (p_name, got is not distinct from p_expected,
    case when got is not distinct from p_expected then null else 'got ' || coalesce(got, 'NULL') || ', expected ' || coalesce(p_expected, 'NULL') end);
end $$;

create function pg_temp.report() returns table (total bigint, failures jsonb)
language sql as $$
  select (select count(*) from results),
         (select jsonb_agg(jsonb_build_object('name', name, 'detail', detail)) from results where not pass);
$$;
