-- 0001: core tables, constraints, indexes. RLS is turned on in 0003; until then
-- nothing is granted to anon/authenticated (0007 is the final grants audit).
-- Replaces firestore.rules data model. Safe to re-run on staging (drops first).

create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;

create table if not exists app_private.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

create table if not exists public.events (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{1,100}$'),
  owner_uid uuid not null,
  owner_email text not null default '',
  name text not null check (char_length(name) between 1 and 80),
  type text not null default '',
  date text not null default '',
  venue text not null default '' check (char_length(venue) <= 100),
  maps_link text not null default '' check (char_length(maps_link) <= 300),
  theme text not null default '',
  welcome_message text not null default '' check (char_length(welcome_message) <= 400),
  paid boolean not null default false,
  guest_limit integer check (guest_limit is null or guest_limit >= 0),
  guest_count integer not null default 0 check (guest_count >= 0),
  scanned_count integer not null default 0 check (scanned_count >= 0),
  slug text unique,
  created_at timestamptz not null default now()
);
create index if not exists events_owner_idx on public.events (owner_uid);

create table if not exists public.event_secrets (
  event_id text primary key references public.events(id) on delete cascade,
  scan_pin text not null default ''
);

create table if not exists public.scan_sessions (
  event_id text not null references public.events(id) on delete cascade,
  uid uuid not null,
  pin text not null,
  created_at timestamptz not null default now(),
  primary key (event_id, uid)
);

-- failed door-code attempts, per device (anonymous uid): 10 in 10 min -> 10 min lock
create table if not exists public.scan_attempts (
  id bigint generated always as identity primary key,
  event_id text not null references public.events(id) on delete cascade,
  uid uuid not null,
  failed_at timestamptz not null default now()
);
create index if not exists scan_attempts_idx on public.scan_attempts (event_id, uid, failed_at);

create table if not exists public.guests (
  event_id text not null references public.events(id) on delete cascade,
  id text not null,                       -- the barcode text, e.g. WD-XXXX
  name text not null check (char_length(name) between 1 and 100),
  req_id text,
  scanned boolean not null default false,
  scanned_at timestamptz,
  vip boolean not null default false,
  registered_at timestamptz not null default now(),
  changed_at timestamptz not null default now(),  -- any check-in / undo; delta sync key
  primary key (event_id, id)
);
create index if not exists guests_changed_idx on public.guests (event_id, changed_at);
create index if not exists guests_name_idx on public.guests (event_id, name);

create table if not exists public.requests (
  event_id text not null references public.events(id) on delete cascade,
  id text not null check (char_length(id) >= 20),
  name text not null check (char_length(name) between 1 and 100),
  status text not null default 'pending' check (status in ('pending', 'approved')),
  guest_id text,
  vip boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (event_id, id)
);

create table if not exists public.account_limits (
  uid uuid primary key,
  event_limit integer not null default 1 check (event_limit >= 0),
  event_count integer not null default 0 check (event_count >= 0)
);

create table if not exists public.event_requests (
  id uuid primary key default gen_random_uuid(),
  uid uuid not null,
  email text not null default '',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_at timestamptz not null default now()
);
create index if not exists event_requests_uid_idx on public.event_requests (uid);

create table if not exists public.users (
  uid uuid primary key,
  email text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.slugs (
  slug text primary key
    check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$')
    check (slug not in ('index','app','event','invite','scan','guide','icons','tests',
      'sitemap','robots','manifest','sw','utils','format','admin','login','www','api','404','privacy')),
  event_id text not null unique references public.events(id) on delete cascade,
  owner_uid uuid not null,
  created_at timestamptz not null default now()
);
