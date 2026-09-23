// ════════════════════════════════════════════════════════════════════
// RETRIEVAL — finding the chunks that answer the question
//
//   question ──embed──▶ hybrid search (meaning + keywords, top 20)
//                        ──▶ rerank (read question + chunk together, score 0–1)
//                        ──▶ keep the best 6 that clear the relevance bar
//
// The audience filter happens inside the database query (hybrid_search), so
// dealer chunks are never even candidates unless includeDealer is true — and
// includeDealer is decided by the server from a verified login, never by
// anything the user types.
// ════════════════════════════════════════════════════════════════════

import { withContext } from "./chunking";
import { config } from "./config";
import { db } from "./supabase";
import type { RetrievedChunk } from "./types";
import { embed, rerank } from "./voyage";

/** Turn a question into an OR-keyword query: "does it fit a Club Car?" → "does | it | fit | club | car". */
export function toKeywordQuery(question: string): string {
  const words = question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2);
  return [...new Set(words)].join(" | ");
}

type SearchRow = {
  chunk_id: number; document_path: string; document_title: string; audience: "public" | "dealer";
  approved_for_claims: boolean; last_updated: string; section: string | null; content: string;
  vector_similarity: number | null; keyword_score: number | null; rrf_score: number;
};

export interface RetrievalResult {
  /** Every candidate from hybrid search, with all scores — for the CLI's debug view. */
  candidates: RetrievedChunk[];
  /** The chunks that will be shown to Claude (rerank ≥ threshold, best first, max N). */
  relevant: RetrievedChunk[];
}

export async function retrieve(question: string, includeDealer: boolean): Promise<RetrievalResult> {
  const { vectors } = await embed([question], "query");

  const { data, error } = await db().rpc("hybrid_search", {
    query_embedding: vectors[0],
    keyword_query: toKeywordQuery(question),
    include_dealer: includeDealer,
    match_count: config.searchCandidates,
  });
  if (error) throw new Error(`Search failed: ${error.message}`);

  const rows = (data ?? []) as SearchRow[];
  const scores = await rerank(
    question,
    rows.map((r) => withContext(r.document_title, r.section, r.content)),
  );

  const candidates: RetrievedChunk[] = rows
    .map((r, i) => ({
      chunkId: r.chunk_id,
      documentPath: r.document_path,
      documentTitle: r.document_title,
      audience: r.audience,
      approvedForClaims: r.approved_for_claims,
      lastUpdated: r.last_updated,
      section: r.section,
      content: r.content,
      vectorSimilarity: r.vector_similarity,
      keywordScore: r.keyword_score,
      rrfScore: r.rrf_score,
      rerankScore: scores[i] ?? 0,
    }))
    .sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0));

  const relevant = candidates
    .filter((c) => (c.rerankScore ?? 0) >= config.relevanceThreshold)
    .slice(0, config.chunksForAnswer);

  return { candidates, relevant };
}
