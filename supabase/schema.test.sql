-- ============================================================================
-- schema.test.sql — proves the schema does what it claims.
--
-- This is NOT something you run on Supabase. It runs on a throwaway local
-- Postgres: it fakes the two things Supabase adds (auth.users and auth.uid()),
-- applies schema.sql, then checks that one user cannot see or damage another
-- user's rows.
--
--   scripts/test-schema.sh
--
-- Every check raises an exception on failure, so the script exits non-zero.
-- ============================================================================

\set ON_ERROR_STOP on

-- ── the Supabase bits a bare Postgres does not have ────────────────────────
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid
  language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

grant usage on schema public, auth to anon, authenticated, service_role;

\ir schema.sql

-- ── fixtures ───────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'alice@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.com')
on conflict do nothing;

\echo '1 · alice writes twelve rows and can read them'
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
insert into public.asx_journal (user_id, at, lane, kind)
  select '11111111-1111-4111-8111-111111111111', now() - (g || ' min')::interval, 'lab', 'ROW'
  from generate_series(1, 12) g;
do $$
declare n int;
begin
  select count(*) into n from public.asx_journal;
  if n <> 12 then raise exception 'alice should see 12 rows, saw %', n; end if;
  raise notice '   ok — alice sees 12';
end $$;

\echo '2 · bob sees none of it'
set request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
do $$
declare n int;
begin
  select count(*) into n from public.asx_journal;
  if n <> 0 then raise exception 'row level security leaked: bob saw %', n; end if;
  raise notice '   ok — bob sees 0';
end $$;

\echo '3 · bob cannot write a row in alice''s name'
do $$
begin
  begin
    insert into public.asx_journal (user_id, at, lane, kind)
      values ('11111111-1111-4111-8111-111111111111', now(), 'scalp', 'SIGNAL');
    raise exception 'bob was allowed to write for alice';
  exception when insufficient_privilege then
    raise notice '   ok — refused by the policy';
  end;
end $$;

\echo '4 · bob cannot trim alice''s journal through the housekeeping function'
do $$
begin
  begin
    perform public.asx_trim_journal('11111111-1111-4111-8111-111111111111', 0);
    raise exception 'bob trimmed alice''s rows';
  exception when insufficient_privilege then
    raise notice '   ok — "not your rows"';
  end;
end $$;

\echo '5 · alice trims her own, down to five'
set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
select public.asx_trim_journal('11111111-1111-4111-8111-111111111111', 5);
do $$
declare n int;
begin
  select count(*) into n from public.asx_journal;
  if n <> 5 then raise exception 'trim left % rows, wanted 5', n; end if;
  raise notice '   ok — kept the newest 5';
end $$;

\echo '6 · the dedupe book refuses the same key twice'
do $$
declare wrote int;
begin
  insert into public.asx_sent (user_id, key) values
    ('11111111-1111-4111-8111-111111111111', 'BTC|BUY|100'),
    ('11111111-1111-4111-8111-111111111111', 'SOL|BUY|9')
  on conflict (user_id, key) do nothing;
  get diagnostics wrote = row_count;
  if wrote <> 2 then raise exception 'first claim wrote % rows, wanted 2', wrote; end if;

  insert into public.asx_sent (user_id, key) values
    ('11111111-1111-4111-8111-111111111111', 'BTC|BUY|100'),
    ('11111111-1111-4111-8111-111111111111', 'ETH|SELL|2')
  on conflict (user_id, key) do nothing;
  get diagnostics wrote = row_count;
  if wrote <> 1 then raise exception 'second claim wrote % rows, wanted 1', wrote; end if;
  raise notice '   ok — the same break is refused, a new one is accepted';
end $$;

\echo '7 · the sweep job sees every user and can trim any of them'
reset role;
set role service_role;
do $$
declare n int;
begin
  insert into public.asx_journal (user_id, at, lane, kind)
    values ('22222222-2222-4222-8222-222222222222', now(), 'scalp', 'SIGNAL');
  select count(*) into n from public.asx_journal;
  if n <> 6 then raise exception 'service role saw % rows, wanted 6', n; end if;
  perform public.asx_trim_journal('22222222-2222-4222-8222-222222222222', 5);
  raise notice '   ok — service role bypasses RLS, as intended';
end $$;

reset role;
\echo ''
\echo 'ALL SCHEMA CHECKS PASSED'
