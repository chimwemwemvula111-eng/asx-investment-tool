-- ============================================================================
-- ASX Investment Tool — Supabase schema
--
-- Run this once in the Supabase dashboard → SQL Editor → New query → Run.
-- It is idempotent: running it twice is harmless.
--
-- Every table is scoped to a user and protected by row level security, so a
-- signed-in phone, a laptop and the sweep job can all read the same data and
-- nobody else can read any of it.
-- ============================================================================

-- ── settings: one row per user, the whole settings object as jsonb ─────────
create table if not exists public.asx_settings (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ── journal: one row per event. This is the table you export from. ─────────
create table if not exists public.asx_journal (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  at          timestamptz not null,
  lane        text not null,
  kind        text not null,
  symbol      text,
  pattern     text,
  direction   text,
  level       double precision,
  "entry"     double precision,
  tag         text,
  note        text,
  body        text,
  created_at  timestamptz not null default now()
);

create index if not exists asx_journal_user_at_idx
  on public.asx_journal (user_id, at desc);
create index if not exists asx_journal_user_lane_at_idx
  on public.asx_journal (user_id, lane, at desc);

-- ── sent: the dedupe book. One row per break already reported. ─────────────
create table if not exists public.asx_sent (
  user_id  uuid not null references auth.users (id) on delete cascade,
  key      text not null,
  at       timestamptz not null default now(),
  primary key (user_id, key)
);

-- ── kv: lane state (the watch tracker) and the run status ──────────────────
create table if not exists public.asx_kv (
  user_id     uuid not null references auth.users (id) on delete cascade,
  key         text not null,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  primary key (user_id, key)
);

-- ============================================================================
-- Row level security
-- ============================================================================
alter table public.asx_settings enable row level security;
alter table public.asx_journal  enable row level security;
alter table public.asx_sent     enable row level security;
alter table public.asx_kv       enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['asx_settings', 'asx_journal', 'asx_sent', 'asx_kv'] loop
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format(
      'create policy "own rows" on public.%I for all to authenticated
         using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

-- ============================================================================
-- Grants. A fresh Supabase project usually inherits these through the public
-- schema's default privileges, but saying it out loud means this file also
-- works on a bare Postgres — and it means `anon` is explicitly locked out.
-- ============================================================================
grant usage on schema public to authenticated;
grant select, insert, update, delete
  on public.asx_settings, public.asx_journal, public.asx_sent, public.asx_kv
  to authenticated;
grant usage, select on sequence public.asx_journal_id_seq to authenticated;
grant select, insert, update, delete
  on public.asx_settings, public.asx_journal, public.asx_sent, public.asx_kv
  to service_role;
revoke all on public.asx_settings, public.asx_journal, public.asx_sent, public.asx_kv from anon;

-- ============================================================================
-- Housekeeping: keep the journal from growing without bound.
-- The app also caps itself, but a server-side cap cannot be skipped.
-- ============================================================================
-- These run with SECURITY DEFINER, which means they bypass row level security.
-- That is deliberate — a housekeeping delete should not be slowed down by a
-- policy — but it also means the function itself has to check who is calling.
-- Without the guard below, any signed-in user could trim somebody else's data
-- by passing their id. service_role has no JWT, so auth.uid() is null there
-- and the sweep job is allowed through.
create or replace function public.asx_only_me(p_user uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  caller_role text := coalesce(current_setting('role', true), '');
begin
  -- the sweep job runs with the service key; it is allowed to touch any user,
  -- because it is the only thing that has that key
  if caller_role in ('service_role', 'postgres', 'supabase_admin') then
    return;
  end if;
  if auth.uid() is not null and auth.uid() <> p_user then
    raise exception 'not your rows' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.asx_trim_journal(p_user uuid, p_keep int default 5000)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.asx_only_me(p_user);
  delete from public.asx_journal
  where user_id = p_user
    and id not in (
      select id from public.asx_journal
      where user_id = p_user
      order by at desc
      limit greatest(p_keep, 1)
    );
end;
$$;

create or replace function public.asx_trim_sent(p_user uuid, p_days int default 14)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.asx_only_me(p_user);
  delete from public.asx_sent
  where user_id = p_user and at < now() - make_interval(days => greatest(p_days, 1));
end;
$$;

-- ============================================================================
-- Housekeeping: the "run now" request from a phone.
-- The site writes to asx_kv key 'run_request'; the sweep job picks it up,
-- runs immediately and clears it. No server to keep alive, no polling loop.
-- ============================================================================
comment on table public.asx_kv is
  'key/value scratch: laneState, status, and run_request (set by the app, cleared by the sweep job)';
