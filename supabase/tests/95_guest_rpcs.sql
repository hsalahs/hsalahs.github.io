-- Chunk 6b: guest writes through functions (event row locked first). t1 has WD-1, WD-2; {A} owns t1.
select pg_temp.t_fail('anon cannot set_guest', $$select public.set_guest('t1','WD-1','x',null)$$, 'anon');
select pg_temp.t_fail('a stranger cannot set_guest', $$select public.set_guest('t1','WD-1','x',null)$$, 'authenticated', pg_temp.uid('B'));
select pg_temp.t_fail('a door device cannot set_guest', $$select public.set_guest('t1','WD-1','x',null)$$, 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('owner renames', $$select public.set_guest('t1','WD-1','  اسم جديد  ',null)::text$$, 'true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('the name is trimmed and stored', $$select name from public.guests where event_id='t1' and id='WD-1'$$, 'اسم جديد');
select pg_temp.t_eq('owner sets vip (name untouched)', $$select public.set_guest('t1','WD-1',null,true)::text$$, 'true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('vip stored, name kept', $$select vip::text || '/' || name from public.guests where event_id='t1' and id='WD-1'$$, 'true/اسم جديد');
select pg_temp.t_eq('unknown guest returns false', $$select public.set_guest('t1','WD-NOPE','x',null)::text$$, 'false', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_fail('empty name', $$select public.set_guest('t1','WD-1','',null)$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_fail('101-char name', format($$select public.set_guest('t1','WD-1',%L,null)$$, repeat('x', 101)), 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('admin may edit', $$select public.set_guest('t1','WD-2',null,true)::text$$, 'true', 'authenticated', pg_temp.uid('ADM'));
-- set_guest_scanned
select pg_temp.t_fail('a stranger cannot set_guest_scanned', $$select public.set_guest_scanned('t1','WD-1',true)$$, 'authenticated', pg_temp.uid('B'));
select pg_temp.t_fail('a door device cannot set_guest_scanned', $$select public.set_guest_scanned('t1','WD-1',true)$$, 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_fail('null flag', $$select public.set_guest_scanned('t1','WD-1',null)$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('owner checks a guest in by hand', $$select public.set_guest_scanned('t1','WD-1',true)::text$$, 'true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('scanned_count is 1', $$select scanned_count from public.events where id='t1'$$, '1');
select pg_temp.t_eq('owner undoes it', $$select public.set_guest_scanned('t1','WD-1',false)::text$$, 'true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('scanned_count back to 0', $$select scanned_count from public.events where id='t1'$$, '0');
-- remove_guest
select pg_temp.t_fail('a stranger cannot remove', $$select public.remove_guest('t1','WD-1')$$, 'authenticated', pg_temp.uid('B'));
select pg_temp.t_fail('a door device cannot remove', $$select public.remove_guest('t1','WD-1')$$, 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_fail('anon cannot remove', $$select public.remove_guest('t1','WD-1')$$, 'anon');
select pg_temp.t_eq('owner removes a guest', $$select public.remove_guest('t1','WD-2')::text$$, 'true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('guest_count dropped', $$select guest_count from public.events where id='t1'$$, '1');
select pg_temp.t_eq('removing again returns false', $$select public.remove_guest('t1','WD-2')::text$$, 'false', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('removing a checked-in guest lowers scanned_count too', $$select public.set_guest_scanned('t1','WD-1',true)::text$$, 'true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('...count is 1', $$select scanned_count from public.events where id='t1'$$, '1');
select pg_temp.t_eq('...remove', $$select public.remove_guest('t1','WD-1')::text$$, 'true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('...counts are 0/0', $$select guest_count || '/' || scanned_count from public.events where id='t1'$$, '0/0');
select * from pg_temp.report();
