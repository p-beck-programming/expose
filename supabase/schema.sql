-- ═══════════════════════════════════════════════════════════════
-- EXPOSÉ — Supabase schema
-- Run this ONCE in the Supabase Dashboard → SQL Editor → New query.
-- Safe to re-run: everything is create-or-replace / if-not-exists.
--
-- What it creates:
--   profiles    — one row per auth user; holds the settings JSON
--                 (geminiApiKey, refreshRate, palette, geminiModel, …)
--   topics      — monitored topics; subtopics live as JSONB on the row
--   articles    — the Library / Dossier (filed links + notes)
--   search_log  — query history shown in the sidebar
--
-- Security model:
--   Row Level Security on every table — a signed-in user can only
--   touch rows where user_id = auth.uid(). The browser talks to the
--   database directly with the public anon key; RLS is the wall.
--   The Cloudflare Worker uses the service-role key (never shipped
--   to the browser) for the scheduled refresh.
-- ═══════════════════════════════════════════════════════════════

-- ── profiles ────────────────────────────────────────────────────
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  settings   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles select own" on public.profiles;
create policy "profiles select own" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "profiles insert own" on public.profiles;
create policy "profiles insert own" on public.profiles
  for insert with check (auth.uid() = id);

drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- Auto-create a profile row whenever a user signs up (email or Google).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── topics ──────────────────────────────────────────────────────
create table if not exists public.topics (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name                   text not null,
  sources                jsonb not null default '{"web":[],"rss":[],"youtube":[],"reddit":[]}'::jsonb,
  strict_mode            boolean not null default false,
  max_subtopics          integer not null default 3,
  all_sources_enabled    boolean not null default false,
  dismissed_subtopics    jsonb not null default '[]'::jsonb,
  pinned                 boolean not null default false,
  paused                 boolean not null default false,
  position               double precision not null default 0,
  source_rotation_offset integer not null default 0,
  heat_score             integer not null default 0,
  subtopics              jsonb not null default '[]'::jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  refreshed_at           timestamptz   -- last SERVER-side (cron) refresh; null = never
);

create index if not exists topics_user_idx on public.topics (user_id, position);

alter table public.topics enable row level security;

drop policy if exists "topics all own" on public.topics;
create policy "topics all own" on public.topics
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── articles (Library / Dossier) ────────────────────────────────
-- topic_id is TEXT on purpose: it is a grouping tag, and articles
-- imported from the localStorage era carry old-format topic ids.
create table if not exists public.articles (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  topic_id   text not null default '',
  topic_name text not null default '',
  title      text not null,
  url        text not null,
  source     text not null default '',
  note       text not null default '',
  filed_at   timestamptz not null default now()
);

create index if not exists articles_user_idx on public.articles (user_id, filed_at desc);

alter table public.articles enable row level security;

drop policy if exists "articles all own" on public.articles;
create policy "articles all own" on public.articles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── search_log ──────────────────────────────────────────────────
create table if not exists public.search_log (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  query      text not null,
  topic_id   text not null default '',
  topic_name text not null default '',
  results    integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists search_log_user_idx on public.search_log (user_id, created_at desc);

alter table public.search_log enable row level security;

drop policy if exists "search_log all own" on public.search_log;
create policy "search_log all own" on public.search_log
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── RPC: delete_account ─────────────────────────────────────────
-- Lets a signed-in user delete their own auth record; every table
-- above cascades. Security definer because auth.users is protected.
create or replace function public.delete_account()
returns void
language sql
security definer set search_path = ''
as $$
  delete from auth.users where id = auth.uid();
$$;

revoke all on function public.delete_account() from public, anon;
grant execute on function public.delete_account() to authenticated;

-- ── RPC: topics_due_for_refresh ─────────────────────────────────
-- Called ONLY by the Cloudflare Worker cron (service-role key).
-- Returns the topics whose owner's refreshRate window has elapsed,
-- oldest first, plus the owner's Gemini key + model so the Worker
-- can run the fetch → cluster pipeline server-side.
create or replace function public.topics_due_for_refresh(max_n integer default 2)
returns table (topic jsonb, gemini_key text, gemini_model text)
language sql
security definer set search_path = public
as $$
  select
    to_jsonb(t.*)                                                as topic,
    coalesce(p.settings->>'geminiApiKey', '')                    as gemini_key,
    coalesce(p.settings->>'geminiModel', 'gemini-2.5-flash-lite') as gemini_model
  from public.topics t
  join public.profiles p on p.id = t.user_id
  where coalesce(t.paused, false) = false
    and coalesce(p.settings->>'geminiApiKey', '') <> ''
    and (
      t.refreshed_at is null
      or t.refreshed_at < now() - make_interval(
           mins => greatest(5, coalesce(nullif(p.settings->>'refreshRate','')::integer, 60)))
    )
  order by t.refreshed_at asc nulls first
  limit max_n;
$$;

-- Nobody but the service role may call this (it exposes API keys).
revoke all on function public.topics_due_for_refresh(integer) from public, anon, authenticated;
