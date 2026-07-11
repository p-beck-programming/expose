-- ═══════════════════════════════════════════════
-- EXPOSÉ — Supabase one-time setup
-- Run this whole file once in your project's SQL editor:
--   dash → your project → SQL Editor → New query → paste → Run
--
-- What it creates:
--   1. public.user_data       — one row per user (topics/settings/log as JSONB)
--   2. Row Level Security     — each user can touch ONLY their own row
--   3. on_auth_user_created   — auto-creates the row on signup (incl. Google)
--   4. public.delete_user()   — lets a signed-in user delete their own account
-- ═══════════════════════════════════════════════

-- 1. One row per user. JSONB columns mirror the app's localStorage shape, so
--    the client keeps all of its existing merge/expire logic unchanged.
create table if not exists public.user_data (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  topics     jsonb not null default '[]'::jsonb,
  settings   jsonb not null default '{}'::jsonb,
  search_log jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- 2. Row Level Security — the whole reason a static, no-server app is safe:
--    the browser talks to the DB with the public anon key + the user's JWT,
--    and these policies make any row that isn't yours invisible/untouchable.
alter table public.user_data enable row level security;

drop policy if exists "own row select" on public.user_data;
drop policy if exists "own row insert" on public.user_data;
drop policy if exists "own row update" on public.user_data;
drop policy if exists "own row delete" on public.user_data;

create policy "own row select" on public.user_data
  for select using (auth.uid() = user_id);
create policy "own row insert" on public.user_data
  for insert with check (auth.uid() = user_id);
create policy "own row update" on public.user_data
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own row delete" on public.user_data
  for delete using (auth.uid() = user_id);

-- 3. Auto-create the user_data row the moment an account is created —
--    covers email/password signups AND first-time Google sign-ins.
--    (The client also upserts as a fallback if this trigger is missing.)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.user_data (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 4. Account self-deletion. Clients can never touch auth.users directly, so
--    this SECURITY DEFINER function deletes the *calling* user only
--    (auth.uid() comes from their verified JWT). user_data cascades away.
create or replace function public.delete_user()
returns void
language sql
security definer set search_path = public
as $$
  delete from auth.users where id = auth.uid();
$$;

-- Signed-in users only — anonymous visitors can't call it.
revoke execute on function public.delete_user() from anon, public;
grant  execute on function public.delete_user() to authenticated;
