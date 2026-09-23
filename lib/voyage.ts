// ════════════════════════════════════════════════════════════════════
// EMBEDDINGS & RERANKING (Voyage AI)
//
// An EMBEDDING turns a piece of text into a list of 1,024 numbers — a point
// on a "map of meaning". Texts that mean similar things land near each other,
// even with different words: "How do I clean it?" lands close to "Care:
// wash with mild soap and a microfiber cloth". To search, we embed the
// question and find the chunks whose points are closest.
//
// Voyage embeds questions and documents slightly differently
// (input_type "query" vs "document") — asymmetric search, which is more
// accurate than treating a short question like a paragraph.
//
// A RERANKER is the second, more careful pass. Embeddings compare the
// question and each chunk *separately* (fast, but coarse). The reranker reads
// the question and a chunk *together* and scores 0–1 how well that chunk
// answers it. Too slow to run on everything, perfect for the top 20.
//
// We call Voyage's REST API directly with fetch — two small endpoints, no SDK needed.
// ════════════════════════════════════════════════════════════════════

import { config } from "./config";

const API = "https://api.voyageai.com/v1";
const BATCH_SIZE = 64; // well under Voyage's 1,000-input / token limits

async function post<T>(endpoint: string, body: unknown, attempt = 1): Promise<T> {
  const res = await fetch(`${API}/${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.voyageApiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // Retry rate limits and server hiccups with backoff (1s, 2s, 4s).
  if ((res.status === 429 || res.status >= 500) && attempt <= 3) {
    await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    return post(endpoint, body, attempt + 1);
  }
  if (!res.ok) throw new Error(`Voyage ${endpoint} failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as T;
}

interface EmbedResponse {
  data: { embedding: number[]; index: number }[];
  usage: { total_tokens: number };
}

export async function embed(
  texts: string[],
  inputType: "query" | "document",
): Promise<{ vectors: number[][]; tokens: number }> {
  const vectors: number[][] = new Array(texts.length);
  let tokens = 0;
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const res = await post<EmbedResponse>("embeddings", {
      input: batch,
      model: config.embeddingModel,
      input_type: inputType,
      output_dimension: config.embeddingDimensions,
    });
    for (const d of res.data) vectors[i + d.index] = d.embedding;
    tokens += res.usage.total_tokens;
  }
  return { vectors, tokens };
}

interface RerankResponse {
  data: { index: number; relevance_score: number }[];
  usage: { total_tokens: number };
}

/** Returns a 0–1 relevance score for each document, in the ORIGINAL order. */
export async function rerank(query: string, documents: string[]): Promise<number[]> {
  if (!documents.length) return [];
  const res = await post<RerankResponse>("rerank", {
    query,
    documents,
    model: config.rerankModel,
  });
  const scores = new Array<number>(documents.length).fill(0);
  for (const d of res.data) scores[d.index] = d.relevance_score;
  return scores;
}
