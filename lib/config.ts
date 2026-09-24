// Central place for settings. Every secret comes from environment variables —
// nothing sensitive is ever written in code.

/** Accepted alternative names for settings (hosting dashboards make it easy to shorten a name). */
export const SETTING_ALIASES: Record<string, string[]> = {
  VOYAGE_API_KEY: ["VOYAGE_KEY"],
  SUPABASE_SECRET_KEY: ["SUPABASE_SECRET"],
};

/**
 * Read a setting, forgiving common dashboard paste mistakes: surrounding spaces/newlines,
 * wrapping quotes, and a leading "NAME=" copied along with the value.
 */
export const readSetting = (name: string): string | undefined => {
  for (const n of [name, ...(SETTING_ALIASES[name] ?? [])]) {
    let v = process.env[n]?.trim();
    if (!v) continue;
    v = v.replace(/^[A-Z][A-Z0-9_]*=/, "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();
    if (v) return v;
  }
  return undefined;
};

function required(name: string): string {
  const value = readSetting(name);
  if (!value) {
    throw new Error(`Missing ${name}. Copy .env.example to .env.local and fill it in.`);
  }
  return value;
}

export const config = {
  anthropicApiKey: () => required("ANTHROPIC_API_KEY"),
  voyageApiKey: () => required("VOYAGE_API_KEY"),
  // Accept the URL as copied from either dashboard page ("…supabase.co" or "…supabase.co/rest/v1/").
  supabaseUrl: () => required("SUPABASE_URL").replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, ""),
  supabaseSecretKey: () => required("SUPABASE_SECRET_KEY"),

  /** Anthropic's current recommended model. Override with CLAUDE_MODEL (e.g. claude-sonnet-5). */
  claudeModel: process.env.CLAUDE_MODEL || "claude-opus-5",

  /** Voyage 4 series: best-quality general embeddings; 1024 dims must match vector(1024) in the DB. */
  embeddingModel: "voyage-4-large",
  embeddingDimensions: 1024,
  rerankModel: "rerank-2.5",

  dataDir: process.env.DATA_DIR || "data",

  /** How many chunks hybrid search returns, and how many survive reranking to be shown to Claude. */
  searchCandidates: 20,
  chunksForAnswer: 6,

  /** Reranker score (0–1) below which a chunk is treated as "not relevant". Tuned in Phase 2. */
  relevanceThreshold: Number(process.env.RELEVANCE_THRESHOLD ?? 0.3),

  /** Chunk size targets, in words (~1.3 tokens per English word). */
  chunkTargetWords: 350,
  chunkMaxWords: 500,
  chunkOverlapWords: 50,

  /** Escalation contact shown to customers. Required (no fallback): a live site must never show a
   *  placeholder address. Real values live in .env.local / the host's settings — this repo is public. */
  contact: {
    get phone() {
      return required("CONTACT_PHONE");
    },
    get email() {
      return required("CONTACT_EMAIL");
    },
  },
} as const;

/** USD per million tokens, for the cost line printed after each answer. */
export const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
