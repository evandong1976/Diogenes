-- Hackathon mode: the app signs in with GitHub itself (device flow) and writes
-- profiles with the publishable key. Not secure: anyone with that key can read
-- and overwrite rows. Replace with Supabase Auth + per-user RLS before real users.
drop trigger if exists on_github_identity_change on auth.identities;
drop function if exists private.sync_github_profile();
drop table if exists public.profiles;

create table public.profiles (
  github_id bigint primary key,
  github_login text not null,
  name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles: open read" on public.profiles for select to anon using (true);
create policy "profiles: open insert" on public.profiles for insert to anon with check (true);
create policy "profiles: open update" on public.profiles for update to anon using (true) with check (true);

grant select, insert, update on public.profiles to anon;
