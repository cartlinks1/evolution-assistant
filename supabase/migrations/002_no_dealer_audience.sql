-- ════════════════════════════════════════════════════════════════════
-- 002 — Remove the dealer/public audience split
--
-- Decision (2026-09-23): there is no dealer login and no dealer-only
-- content. Every dealer question (pricing, joining, ordering, terms) gets
-- a fixed "please email us" reply. With only one audience, the audience
-- columns and the include_dealer switch are dead weight, and removing them
-- removes a whole class of possible leaks.
-- ════════════════════════════════════════════════════════════════════

-- Safe to run more than once (it may be pasted into the SQL Editor by hand).

-- Any dealer-folder documents ingested before this change go too (cascade
-- removes their chunks and fitment rows).
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'documents' and column_name = 'audience') then
    delete from documents where audience = 'dealer';
  end if;
end $$;

drop function if exists hybrid_search(vector, text, boolean, int, int);

alter table chunks    drop column if exists audience;
alter table fitment   drop column if exists audience;
alter table documents drop column if exists audience;

-- Same hybrid search as 001, minus the audience filter.
create or replace function hybrid_search(
  query_embedding vector(1024),
  keyword_query   text,              -- pre-built tsquery string like 'club | car | onward'
  match_count     int default 20,
  rrf_k           int default 50
)
returns table (
  chunk_id            bigint,
  document_id         uuid,
  document_path       text,
  document_title      text,
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
  with semantic as (
    select c.id,
           1 - (c.embedding <=> query_embedding) as similarity,
           row_number() over (order by c.embedding <=> query_embedding) as rnk
    from chunks c
    order by c.embedding <=> query_embedding
    limit match_count * 2
  ),
  keyword as (
    select c.id,
           ts_rank_cd(c.fts, q) as score,
           row_number() over (order by ts_rank_cd(c.fts, q) desc) as rnk
    from chunks c, to_tsquery('english', coalesce(nullif(keyword_query, ''), 'zzzznomatch')) q
    where c.fts @@ q
    order by score desc
    limit match_count * 2
  )
  select c.id, d.id, d.path, d.title, d.approved_for_claims, d.last_updated,
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

revoke execute on function hybrid_search from public, anon, authenticated;
