-- ════════════════════════════════════════════════════════════════════
-- 004 — Question log + usage limits for the public chat
--
-- Every website question is logged: what was asked, what the assistant
-- said, whether it answered or handed off, which sources it used, and what
-- it cost. The same table powers the cost protection: per-visitor rate
-- limits, a daily cap, and a monthly budget.
--
-- Visitors are identified only by a salted hash of their IP address, never
-- the IP itself. Locked with RLS like every other table: only the server
-- (secret key) can read or write it.
-- Safe to run more than once.
-- ════════════════════════════════════════════════════════════════════

create table if not exists question_log (
  id                bigint generated always as identity primary key,
  created_at        timestamptz not null default now(),
  session_id        text,                 -- one browser chat session (random, not tied to a person)
  visitor_hash      text not null,        -- salted hash of the visitor's IP (for rate limits)
  question          text not null,
  answer            text,
  status            text not null,        -- answered | clarifying | escalated | rate_limited | error
  escalation_reason text,
  sources           jsonb,                -- titles/sections cited
  model             text,
  input_tokens      int,
  output_tokens     int,
  cost_usd          numeric(10, 5) not null default 0,
  latency_ms        int
);

create index if not exists question_log_created_idx on question_log (created_at desc);
create index if not exists question_log_visitor_idx on question_log (visitor_hash, created_at desc);

alter table question_log enable row level security;

-- One round-trip usage check before answering a question.
create or replace function chat_usage(p_visitor_hash text)
returns table (
  visitor_last_minute int,
  visitor_today       int,
  everyone_today      int,
  cost_this_month     numeric
)
language sql stable
set search_path = public
as $$
  select
    (select count(*) from question_log
       where visitor_hash = p_visitor_hash and created_at > now() - interval '1 minute')::int,
    (select count(*) from question_log
       where visitor_hash = p_visitor_hash and created_at > now() - interval '1 day')::int,
    (select count(*) from question_log
       where created_at > now() - interval '1 day')::int,
    (select coalesce(sum(cost_usd), 0) from question_log
       where created_at >= date_trunc('month', now()));
$$;

revoke execute on function chat_usage from public, anon, authenticated;
