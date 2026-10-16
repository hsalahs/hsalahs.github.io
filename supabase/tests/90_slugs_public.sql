-- Chunk 6: claim_slug / auto_claim_slug / resolve_slug / event_public.
-- t1 (owner {A}) has a fixture slug row 'slug-one' (events.slug is still null), t2 owner {B}.
update public.events set slug = 'slug-one' where id = 't1';
-- resolve / public read (anon)
select pg_temp.t_eq('anon resolves a readable name', $$select public.resolve_slug('slug-one')$$, 't1', 'anon');
select pg_temp.t_eq('unknown name resolves to nothing', $$select coalesce(public.resolve_slug('nope-nope'), 'none')$$, 'none', 'anon');
select pg_temp.t_eq('null name resolves to nothing', $$select coalesce(public.resolve_slug(null), 'none')$$, 'none', 'anon');
update public.events set name = 'حفل', type = 'wedding', date = '2026-12-01', venue = 'القاعة', maps_link = 'https://maps.example/x', theme = 'gold', welcome_message = 'أهلا' where id = 't1';
select pg_temp.t_eq('anon reads the public event fields', $$select name || '|' || type || '|' || date || '|' || venue || '|' || maps_link || '|' || theme || '|' || welcome_message from public.event_public('t1')$$, 'حفل|wedding|2026-12-01|القاعة|https://maps.example/x|gold|أهلا', 'anon');
select pg_temp.t_eq('unknown event gives no row', $$select count(*) from public.event_public('nope')$$, '0', 'anon');
select pg_temp.t_eq('the public view has exactly 7 columns (no owner email, counts, payment)', $$select count(*) from (select * from public.event_public('t1')) s, jsonb_object_keys(to_jsonb(s))$$, '7', 'anon');
select pg_temp.t_eq('a signed-in door device reads it too', $$select name from public.event_public('t1')$$, 'حفل', 'authenticated', pg_temp.uid('D'), true);
-- claim_slug
select pg_temp.t_fail('anon cannot claim', $$select public.claim_slug('t1', 'hello-world')$$, 'anon');
select pg_temp.t_fail('a stranger cannot claim for another event', $$select public.claim_slug('t1', 'hello-world')$$, 'authenticated', pg_temp.uid('B'));
select pg_temp.t_fail('a door device cannot claim', $$select public.claim_slug('t1', 'hello-world')$$, 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_fail('unknown event', $$select public.claim_slug('nope', 'hello-world')$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('owner changes the name', $$select public.claim_slug('t1', 'hello-world')$$, 'hello-world', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('events.slug follows', $$select slug from public.events where id='t1'$$, 'hello-world');
select pg_temp.t_eq('the old name was released', $$select coalesce(public.resolve_slug('slug-one'), 'free')$$, 'free', 'anon');
select pg_temp.t_eq('the new name resolves', $$select public.resolve_slug('hello-world')$$, 't1', 'anon');
select pg_temp.t_eq('one slug row per event', $$select count(*) from public.slugs where event_id='t1'$$, '1');
select pg_temp.t_eq('claiming the same name again is a no-op', $$select public.claim_slug('t1', 'hello-world')$$, 'hello-world', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_fail('a name held by another event: SLUG_TAKEN', $$select public.claim_slug('t2', 'hello-world')$$, 'authenticated', pg_temp.uid('B'));
select pg_temp.t_eq('and it still belongs to the first', $$select public.resolve_slug('hello-world')$$, 't1', 'anon');
select pg_temp.t_eq('a refused claim does not touch the old name', $$select coalesce(slug, 'none') from public.events where id='t2'$$, 'none');
select pg_temp.t_fail('capital letters', $$select public.claim_slug('t2', 'Hello-World')$$, 'authenticated', pg_temp.uid('B'));
select pg_temp.t_fail('too short', $$select public.claim_slug('t2', 'ab')$$, 'authenticated', pg_temp.uid('B'));
select pg_temp.t_fail('starts with a dash', $$select public.claim_slug('t2', '-abc')$$, 'authenticated', pg_temp.uid('B'));
select pg_temp.t_fail('41 chars', $$select public.claim_slug('t2', repeat('a', 41))$$, 'authenticated', pg_temp.uid('B'));
select pg_temp.t_fail('reserved: ' || w, format($$select public.claim_slug('t2', %L)$$, w), 'authenticated', pg_temp.uid('B'))
  from unnest(array['index','app','event','invite','scan','guide','icons','tests','sitemap','robots','manifest','sw','utils','format','admin','login','www','api','404','privacy']) w where char_length(w) >= 3;
select pg_temp.t_eq('B can pick a free name', $$select public.claim_slug('t2', 'my-event')$$, 'my-event', 'authenticated', pg_temp.uid('B'));
select pg_temp.t_eq('admin may rename a customer event', $$select public.claim_slug('t2', 'by-admin')$$, 'by-admin', 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_eq('the slug row keeps the OWNER as owner', $$select owner_uid::text from public.slugs where slug='by-admin'$$, '00000000-0000-0000-0000-0000000000b2');
select pg_temp.t_eq('clearing with the empty name', $$select coalesce(public.claim_slug('t2', ''), 'cleared')$$, 'cleared', 'authenticated', pg_temp.uid('B'));
select pg_temp.t_eq('cleared: no slug row', $$select count(*) from public.slugs where event_id='t2'$$, '0');
select pg_temp.t_eq('cleared on purpose: slug_decided stays true', $$select slug_decided::text || '/' || coalesce(slug, 'null') from public.events where id='t2'$$, 'true/null');
select pg_temp.t_eq('the released name is free again', $$select coalesce(public.resolve_slug('by-admin'), 'free')$$, 'free', 'anon');
-- the owner cannot touch the flag or the slug column directly
select pg_temp.t_fail('owner cannot write slug_decided', $$update public.events set slug_decided = false where id='t1'$$, 'authenticated', pg_temp.uid('A'));
-- auto_claim_slug
insert into public.events (id, owner_uid, name) values ('t6', pg_temp.uid('A'), 'auto one'), ('t7', pg_temp.uid('A'), 'auto two');
select pg_temp.t_fail('a stranger cannot auto-claim', $$select public.auto_claim_slug('t6', 'auto-one')$$, 'authenticated', pg_temp.uid('B'));
select pg_temp.t_fail('even the admin cannot (owner only, like the dashboard)', $$select public.auto_claim_slug('t6', 'auto-one')$$, 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_eq('owner auto-claims the base', $$select public.auto_claim_slug('t6', 'auto-one')$$, 'auto-one', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('a second call returns the same name', $$select public.auto_claim_slug('t6', 'something-else')$$, 'auto-one', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('a taken base gets -2', $$select public.auto_claim_slug('t7', 'auto-one')$$, 'auto-one-2', 'authenticated', pg_temp.uid('A'));
insert into public.events (id, owner_uid, name) values ('t8', pg_temp.uid('A'), 'x'), ('t9', pg_temp.uid('A'), 'y');
select pg_temp.t_eq('a cleared link is never auto-claimed again', $$select coalesce(public.auto_claim_slug('t2', 'cleared-one'), 'null')$$, 'null', 'authenticated', pg_temp.uid('B'));
select pg_temp.t_eq('an invalid base gives null and decides nothing', $$select coalesce(public.auto_claim_slug('t8', 'Bad Name!'), 'null')$$, 'null', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('slug_decided still false after the failed attempt', $$select slug_decided::text from public.events where id='t8'$$, 'false');
select pg_temp.t_eq('a reserved base falls through to -2', $$select public.auto_claim_slug('t8', 'admin')$$, 'admin-2', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('a short base is rejected by the length rule on candidates but -2 fits', $$select public.auto_claim_slug('t9', 'ab')$$, 'ab-2', 'authenticated', pg_temp.uid('A'));
-- deleting an event frees its name
select pg_temp.t_ok('delete the event', $$select public.delete_event('t6')$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('and its name', $$select coalesce(public.resolve_slug('auto-one'), 'free')$$, 'free', 'anon');
-- reviewer follow-ups: length bounds, long auto base, trigger-level guard
insert into public.events (id, owner_uid, name) values ('ta', pg_temp.uid('A'), 'a'), ('tb', pg_temp.uid('A'), 'b'), ('tc', pg_temp.uid('A'), 'c');
select pg_temp.t_eq('3-char slug is the minimum', $$select public.claim_slug('ta', 'abc')$$, 'abc', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('40-char slug is the maximum', format($$select char_length(public.claim_slug('ta', %L))::text$$, repeat('a', 40)), '40', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('a 34-char auto base is accepted', format($$select char_length(public.auto_claim_slug('tb', %L))::text$$, repeat('b', 34)), '34', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('a 36-char auto base is refused (no room for -xxxx)', format($$select coalesce(public.auto_claim_slug('tc', %L), 'null')$$, repeat('c', 36)), 'null', 'authenticated', pg_temp.uid('A'));
select * from pg_temp.report();
