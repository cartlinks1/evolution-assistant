-- ════════════════════════════════════════════════════════════════════
-- 001 — Core RAG storage
--
--   documents  one row per source file (+ its metadata tags)
--   chunks     the searchable pieces of each document, with embeddings
--   fitment    structured make/model/year → SKU rows (exact lookup, not search)
--
-- SECURITY MODEL: Row Level Security is ON for every table and there are
-- NO policies. That means the public "anon" key can read nothing. Only
-- server code holding the secret key (which bypasses RLS) can query — and
-- the server decides whether dealer rows are allowed, never the browser.
-- ════════════════════════════════════════════════════════════════════

create extension if not exists vector;

create table documents (
  id                  uuid primary key default gen_random_uuid(),
  path                text not null unique,           -- e.g. "public/install-guide.md"
  title               text not null,
  audience            text not null check (audience in ('public', 'dealer')),
  approved_for_claims boolean not null default false, -- may back safety/regulatory/performance claims
  last_updated        date not null,
  content_hash        text not null,                  -- lets re-ingest skip unchanged files
  ingested_at         timestamptz not null default now()
);

create table chunks (
  id           bigint generated always as identity primary key,
  document_id  uuid not null references documents(id) on delete cascade,
  chunk_index  int not null,
  section      text,                                  -- heading path or "Page 3"
  content      text not null,                         -- exactly what Claude is shown
  audience     text not null check (audience in ('public', 'dealer')),  -- copied from document for fast filtering
  embedding    vector(1024) not null,                 -- voyage-4-large, 1024 dimensions
  fts          tsvector generated always as (
                 to_tsvector('english', coalesce(section, '') || ' ' || content)
               ) stored                               -- keyword-search index
);

create index chunks_fts_idx on chunks using gin (fts);
create index chunks_document_idx on chunks (document_id);
-- No vector index yet: with a few hundred chunks an exact scan takes milliseconds
-- and is 100% accurate. Add HNSW if the corpus ever reaches tens of thousands of chunks.

create table fitment (
  id           bigint generated always as identity primary key,
  document_id  uuid not null references documents(id) on delete cascade,
  row_number   int not null,                          -- row in the source CSV (for citations)
  make         text not null,
  model        text not null,
  year_start   int,                                   -- null = unknown / all years
  year_end     int,                                   -- null = open-ended ("2021+", "Present")
  year_label   text not null,                         -- original text, e.g. "2004–2023"
  sku          text not null,
  notes        text,
  audience     text not null check (audience in ('public', 'dealer'))
);

create index fitment_make_model_idx on fitment (lower(make), lower(model));
create index fitment_sku_idx on fitment (upper(sku));

alter table documents enable row level security;
alter table chunks    enable row level security;
alter table fitment   enable row level security;

-- ────────────────────────────────────────────────────────────────────
-- hybrid_search: meaning search + keyword search, merged.
--
-- 1. "semantic"  ranks chunks by how close their embedding is to the question's.
-- 2. "keyword"   ranks chunks by classic word matching (great for SKUs, model names).
-- 3. The two ranked lists are merged with Reciprocal Rank Fusion: each chunk
--    scores 1/(k + rank) from each list it appears in. Chunks both methods like
--    rise to the top; neither method's raw scores need to be comparable.
--
-- The audience filter is applied FIRST, inside the database. When
-- include_dealer is false, dealer chunks are never even considered.
-- ────────────────────────────────────────────────────────────────────
create or replace function hybrid_search(
  query_embedding vector(1024),
  keyword_query   text,              -- pre-built tsquery string like 'club | car | onward'
  include_dealer  boolean default false,
  match_count     int default 20,
  rrf_k           int default 50
)
returns table (
  chunk_id            bigint,
  document_id         uuid,
  document_path       text,
  document_title      text,
  audience            text,
  approved_for_claims boolean,
  last_updated        date,
  section             text,
  content             text,
  vector_similarity   float,
  keyword_score       float,
  rrf_score           float
)
language sql stable
set search_path = public, extensions
as $$
  with allowed as (
    select c.*
    from chunks c
    where c.audience = 'public' or (include_dealer and c.audience = 'dealer')
  ),
  semantic as (
    select a.id,
           1 - (a.embedding <=> query_embedding) as similarity,
           row_number() over (order by a.embedding <=> query_embedding) as rnk
    from allowed a
    order by a.embedding <=> query_embedding
    limit match_count * 2
  ),
  keyword as (
    select a.id,
           ts_rank_cd(a.fts, q) as score,
           row_number() over (order by ts_rank_cd(a.fts, q) desc) as rnk
    from allowed a, to_tsquery('english', coalesce(nullif(keyword_query, ''), 'zzzznomatch')) q
    where a.fts @@ q
    order by score desc
    limit match_count * 2
  )
  select c.id, d.id, d.path, d.title, c.audience, d.approved_for_claims, d.last_updated,
         c.section, c.content,
         s.similarity, k.score,
         coalesce(1.0 / (rrf_k + s.rnk), 0) + coalesce(1.0 / (rrf_k + k.rnk), 0) as rrf
  from semantic s
  full outer join keyword k on k.id = s.id
  join chunks c on c.id = coalesce(s.id, k.id)
  join documents d on d.id = c.document_id
  order by rrf desc
  limit match_count;
$$;

-- Only server code (secret key) may call it.
revoke execute on function hybrid_search from public, anon, authenticated;
