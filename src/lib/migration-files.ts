export const MIGRATIONS = [
  {
    filename: "0001_initial.sql",
    sql: `create table if not exists suimesh_agents (
  agent_id text primary key,
  owner_user_id text,
  manifest jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists suimesh_users (
  user_id text primary key,
  wallet_address text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists suimesh_auth_challenges (
  challenge_id text primary key,
  wallet_address text not null,
  message text not null,
  nonce text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists suimesh_user_sessions (
  session_token_hash text primary key,
  user_id text not null,
  wallet_address text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists suimesh_sessions (
  session_id text primary key,
  owner_user_id text,
  semantic_type text not null default 'transfer',
  status text not null default 'ready',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists suimesh_events (
  id bigserial primary key,
  event_hash text not null unique,
  event_id text not null unique,
  session_id text not null,
  trace_id text,
  event_type text not null,
  actor text not null,
  previous_event_hash text,
  created_at_ms bigint,
  envelope jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists suimesh_events_session_id_id_idx
  on suimesh_events (session_id, id);

create index if not exists suimesh_events_trace_id_id_idx
  on suimesh_events (trace_id, id);

create table if not exists suimesh_trace_anchors (
  action_hash text primary key,
  anchor jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists suimesh_trace_runs (
  trace_id text primary key,
  session_id text not null,
  owner_user_id text,
  semantic_type text not null,
  action_hash text,
  action jsonb,
  inspection jsonb,
  decision jsonb,
  anchor jsonb,
  claim jsonb,
  receipt jsonb,
  status text not null default 'proposed',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists suimesh_trace_runs_session_id_idx
  on suimesh_trace_runs (session_id);

alter table suimesh_agents
  add column if not exists owner_user_id text;

alter table suimesh_sessions
  add column if not exists owner_user_id text;

alter table suimesh_trace_runs
  add column if not exists owner_user_id text;

create index if not exists suimesh_trace_runs_owner_user_id_idx
  on suimesh_trace_runs (owner_user_id, updated_at desc);

create index if not exists suimesh_sessions_owner_user_id_idx
  on suimesh_sessions (owner_user_id, updated_at desc);

create index if not exists suimesh_agents_owner_user_id_idx
  on suimesh_agents (owner_user_id, updated_at desc);

create index if not exists suimesh_auth_challenges_wallet_address_idx
  on suimesh_auth_challenges (wallet_address, created_at desc);

create index if not exists suimesh_user_sessions_user_id_idx
  on suimesh_user_sessions (user_id, expires_at desc);

create table if not exists suimesh_blobs (
  blob_id text primary key,
  digest text not null,
  content_type text,
  encrypted boolean not null default true,
  bytes bytea not null,
  created_at timestamptz not null default now()
);

create table if not exists suimesh_rate_limits (
  bucket text not null,
  subject text not null,
  window_start timestamptz not null,
  count integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (bucket, subject)
);

create index if not exists suimesh_rate_limits_updated_at_idx
  on suimesh_rate_limits (updated_at desc);
`,
  },
] as const;
