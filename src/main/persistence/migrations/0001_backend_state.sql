-- Diogenes backend state, version 1. Additive and private to the backend: everything lives in the
-- unexposed `private` schema, RLS is on with no policies (defense in depth), and the Data API
-- roles get no privileges. Only the main process, connecting as the database owner, reads it.

create schema if not exists private;
revoke all on schema private from anon, authenticated;

-- Rejects UPDATE (and DELETE where attached) on records that are frozen once written.
create or replace function private.dg_frozen() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% is immutable', tg_table_name using errcode = '42501';
end $$;

-- ----------------------------------------------------------------- threads

create table private.dg_threads (
  project_id text not null check (project_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  thread_id  text not null check (thread_id ~ '^thr_[A-Za-z0-9-]{1,64}$'),
  kind       text not null check (kind in ('design', 'coding')),
  title      text not null default '',
  provider   jsonb,
  last_seq   integer not null default 0 check (last_seq >= 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (project_id, thread_id)
);

create table private.dg_thread_events (
  project_id text not null,
  thread_id  text not null,
  seq        integer not null check (seq > 0),
  event_id   text not null,
  -- The event without id, seq and at.
  body       jsonb not null,
  at         timestamptz not null,
  primary key (project_id, thread_id, seq),
  unique (project_id, thread_id, event_id),
  foreign key (project_id, thread_id) references private.dg_threads on delete cascade
);
create trigger dg_thread_events_frozen before update on private.dg_thread_events
  for each row execute function private.dg_frozen();

-- ----------------------------------------------------------------- design draft, proposals, turns

-- One document per project, changed only inside a row-locked transaction, so draft revision
-- checks on approval hold across processes.
create table private.dg_design_projects (
  project_id text primary key check (project_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  state      jsonb not null,
  version    bigint not null default 1,
  updated_at timestamptz not null default now()
);

-- ----------------------------------------------------------------- approvals and handoffs

-- The frozen approval packet. approval_id is the SHA-256 of the exact bytes, checked here too.
create table private.dg_approvals (
  approval_id  text primary key check (approval_id ~ '^[0-9a-f]{64}$'),
  project_id   text not null,
  proposal_id  text not null,
  correlation  jsonb not null,
  packet_bytes text not null,
  approved_by  text not null,
  approved_at  timestamptz not null,
  check (encode(sha256(convert_to(packet_bytes, 'UTF8')), 'hex') = approval_id)
);
create index dg_approvals_project_proposal on private.dg_approvals (project_id, proposal_id);
create trigger dg_approvals_frozen before update on private.dg_approvals
  for each row execute function private.dg_frozen();

create table private.dg_handoffs (
  handoff_id  text primary key,
  project_id  text not null,
  approval_id text not null references private.dg_approvals,
  stage       text not null
    check (stage in ('coding', 'verifying', 'accepted', 'correctable', 'needs-decision', 'closed')),
  record      jsonb not null,
  created_at  timestamptz not null,
  updated_at  timestamptz not null
);
create index dg_handoffs_project on private.dg_handoffs (project_id, created_at);
create index dg_handoffs_approval on private.dg_handoffs (approval_id);

-- ----------------------------------------------------------------- managed coding runs

create table private.dg_coding_runs (
  run_id              text primary key check (run_id ~ '^run_[0-9a-f]{32}$'),
  project_id          text not null,
  handoff_id          text not null,
  -- Frozen start input (handoff and staged sources). Never rewritten.
  input               jsonb not null,
  run                 jsonb not null,
  phase               text not null,
  -- Continuation references, mirrored from `run` for lookup.
  environment_id      text,
  last_interaction_id text,
  created_at          timestamptz not null,
  updated_at          timestamptz not null
);
create index dg_coding_runs_project on private.dg_coding_runs (project_id, created_at);
create index dg_coding_runs_handoff on private.dg_coding_runs (handoff_id);

create or replace function private.dg_coding_input_frozen() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.input is distinct from old.input or new.project_id is distinct from old.project_id
     or new.handoff_id is distinct from old.handoff_id then
    raise exception 'coding run input is immutable' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger dg_coding_runs_input_frozen before update on private.dg_coding_runs
  for each row execute function private.dg_coding_input_frozen();

-- ----------------------------------------------------------------- candidates and verdicts

-- Append-only evidence, written in the same transaction as the handoff that produced it.
create table private.dg_candidates (
  handoff_id   text not null references private.dg_handoffs,
  attempt      integer not null check (attempt > 0),
  project_id   text not null,
  candidate_id text not null check (candidate_id ~ '^[0-9a-f]{40}$'),
  run_id       text not null,
  record       jsonb not null,
  created_at   timestamptz not null default now(),
  primary key (handoff_id, attempt)
);
create trigger dg_candidates_frozen before update on private.dg_candidates
  for each row execute function private.dg_frozen();

create table private.dg_verdicts (
  verdict_id   text primary key,
  project_id   text not null,
  handoff_id   text not null references private.dg_handoffs,
  approval_id  text not null references private.dg_approvals,
  run_id       text not null,
  candidate_id text not null,
  verifier     text not null,
  overall      text not null check (overall in ('pass', 'fail', 'unknown')),
  verdict      jsonb not null,
  verified_at  timestamptz not null
);
create index dg_verdicts_handoff on private.dg_verdicts (handoff_id, verified_at);
create trigger dg_verdicts_frozen before update on private.dg_verdicts
  for each row execute function private.dg_frozen();

-- ----------------------------------------------------------------- lock down

alter table private.dg_threads enable row level security;
alter table private.dg_thread_events enable row level security;
alter table private.dg_design_projects enable row level security;
alter table private.dg_approvals enable row level security;
alter table private.dg_handoffs enable row level security;
alter table private.dg_coding_runs enable row level security;
alter table private.dg_candidates enable row level security;
alter table private.dg_verdicts enable row level security;

revoke all on all tables in schema private from anon, authenticated;
revoke all on function private.dg_frozen() from public, anon, authenticated;
revoke all on function private.dg_coding_input_frozen() from public, anon, authenticated;
