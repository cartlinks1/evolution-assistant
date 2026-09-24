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
  /** Customer-facing product name ("Evolution AS-4 Premium Windshield for Club Car"). SKUs are never shown. */
  product: string | null;
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
