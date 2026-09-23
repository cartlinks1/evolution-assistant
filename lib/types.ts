/** Metadata tags attached to every source document. */
export interface DocumentMeta {
  /** Path relative to the data folder, e.g. "install-guide.pdf". */
  path: string;
  title: string;
  approvedForClaims: boolean;
  /** ISO date, YYYY-MM-DD. */
  lastUpdated: string;
}

/** A piece of a document before it is embedded. */
export interface DraftChunk {
  section: string | null;
  content: string;
}

/** One parsed fitment row from a fitment CSV. */
export interface FitmentRow {
  rowNumber: number;
  make: string;
  model: string;
  yearStart: number | null;
  yearEnd: number | null;
  yearLabel: string;
  sku: string;
  notes: string | null;
}

/** A chunk returned by retrieval, with every score we computed along the way. */
export interface RetrievedChunk {
  chunkId: number;
  documentPath: string;
  documentTitle: string;
  approvedForClaims: boolean;
  lastUpdated: string;
  section: string | null;
  content: string;
  vectorSimilarity: number | null;
  keywordScore: number | null;
  rrfScore: number;
  rerankScore: number | null;
}
