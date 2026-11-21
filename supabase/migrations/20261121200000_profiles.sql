-- One profile per Supabase user who signed in with GitHub.
-- Filled from auth.identities (written by Supabase Auth), never by the client,
-- so github_id can be trusted for authorization later.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  github_id bigint not null unique,
  github_login text not null,
  name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Users read their own profile. No insert/update/delete policies: only the trigger writes.
create policy "profiles: read own"
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = id);

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;

create schema if not exists private;

create function private.sync_github_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.provider <> 'github' then
    return new;
  end if;
  insert into public.profiles (id, github_id, github_login, name, avatar_url)
  values (
    new.user_id,
    new.provider_id::bigint,
    new.identity_data ->> 'user_name',
    new.identity_data ->> 'full_name',
    new.identity_data ->> 'avatar_url'
  )
  on conflict (id) do update set
    github_id = excluded.github_id,
    github_login = excluded.github_login,
    name = excluded.name,
    avatar_url = excluded.avatar_url,
    updated_at = now();
  return new;
end;
$$;

revoke execute on function private.sync_github_profile() from public, anon, authenticated;

-- Runs on first sign-in and again whenever Supabase refreshes the GitHub data
-- (e.g. a renamed login or new avatar).
create trigger on_github_identity_change
  after insert or update of identity_data on auth.identities
  for each row execute function private.sync_github_profile();
