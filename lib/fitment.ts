// ════════════════════════════════════════════════════════════════════
// FITMENT — exact lookup instead of fuzzy search
//
// Fitment is the one place a "close enough" answer is actively harmful.
// Search engines (meaning-based or keyword-based) can't do arithmetic: a row
// that says "2004–2023" never contains the text "2019", so a question about
// a 2019 cart may not find it. So fitment rows go into a normal database
// table with numeric year_start / year_end, and we look them up exactly:
//     make = X  AND  model = Y  AND  year_start ≤ 2019 ≤ year_end
// No row → the assistant says it's not in our fitment list. It never guesses.
// ════════════════════════════════════════════════════════════════════

import type { SupabaseClient } from "@supabase/supabase-js";
import { filterSentences, type CitedSegment, type GuardResult } from "./claims";
import type { FitmentRow } from "./types";

/** Header names we accept for each field (case-insensitive). */
const HEADER_ALIASES: Record<keyof Omit<FitmentRow, "rowNumber" | "yearStart" | "yearEnd">, string[]> = {
  make: ["make", "brand", "manufacturer", "cart make"],
  model: ["model", "cart model"],
  yearLabel: ["year range", "years", "year_range", "year", "model years"],
  sku: ["sku", "part number", "part", "variant sku"],
  notes: ["notes", "note", "comments", "fitment notes"],
};

function findHeader(headers: string[], aliases: string[]): string | undefined {
  const lower = headers.map((h) => h.trim().toLowerCase());
  const idx = lower.findIndex((h) => aliases.includes(h));
  return idx >= 0 ? headers[idx] : undefined;
}

/** A CSV is treated as fitment data if it has make, model and SKU columns. */
export function isFitmentCsv(headers: string[]): boolean {
  return ["make", "model", "sku"].every((k) =>
    findHeader(headers, HEADER_ALIASES[k as "make" | "model" | "sku"]),
  );
}

/**
 * Parse a year label into a numeric range.
 *   "2004–2023" / "2004-2023" / "2004 to 2023"  → 2004..2023
 *   "2019"                                        → 2019..2019
 *   "2021+" / "2021-Present" / "2021 and newer"   → 2021..open
 *   "Up to 2015" / "-2015"                        → open..2015
 *   "" / "All"                                    → open..open
 * Two-digit years ("04-23") are expanded to 20xx.
 */
export function parseYearRange(label: string): { start: number | null; end: number | null } {
  const s = label.trim().toLowerCase();
  if (!s || s === "all" || s === "all years") return { start: null, end: null };

  const expand = (y: string) => {
    const n = Number(y);
    return y.length === 2 ? 2000 + n : n;
  };
  const years = [...s.matchAll(/\b(\d{4}|\d{2})\b/g)].map((m) => expand(m[1]!));
  const openEnd = /\+|present|current|newer|later|up\s*$|onward/.test(s);
  const openStart = /^(up to|through|thru|before|and older|-)/.test(s) || /older|earlier/.test(s);

  if (years.length >= 2) return { start: Math.min(...years), end: Math.max(...years) };
  if (years.length === 1) {
    const y = years[0]!;
    if (openEnd) return { start: y, end: null };
    if (openStart) return { start: null, end: y };
    return { start: y, end: y };
  }
  return { start: null, end: null };
}

export function parseFitmentRows(rows: Record<string, string>[]): FitmentRow[] {
  if (!rows.length) return [];
  const headers = Object.keys(rows[0]!);
  const col = (k: keyof typeof HEADER_ALIASES) => findHeader(headers, HEADER_ALIASES[k]);
  const cMake = col("make")!, cModel = col("model")!, cSku = col("sku")!;
  const cYear = col("yearLabel"), cNotes = col("notes");

  return rows
    .map((r, i) => {
      const yearLabel = (cYear ? r[cYear] : "")?.trim() ?? "";
      const { start, end } = parseYearRange(yearLabel);
      return {
        rowNumber: i + 2,
        make: r[cMake]?.trim() ?? "",
        model: r[cModel]?.trim() ?? "",
        yearStart: start,
        yearEnd: end,
        yearLabel: yearLabel || "not specified",
        sku: r[cSku]?.trim().toUpperCase() ?? "",
        notes: (cNotes ? r[cNotes]?.trim() : "") || null,
      };
    })
    .filter((r) => r.make && r.model && r.sku);
}

// ─── Lookup ─────────────────────────────────────────────────────────

const escapeLike = (s: string) => s.trim().replace(/[\\%_]/g, (c) => `\\${c}`);

/** No year asked → every row matches. Null bounds mean "open-ended" on that side. */
export function yearInRange(year: number | null | undefined, start: number | null, end: number | null): boolean {
  if (!year) return true;
  return (start === null || start <= year) && (end === null || year <= end);
}

export interface FitmentQuery {
  make?: string | null;
  model?: string | null;
  year?: number | null;
  sku?: string | null;
}

export interface FitmentMatch extends FitmentRow {
  documentTitle: string;
  documentPath: string;
  lastUpdated: string;
}

type FitmentDbRow = {
  row_number: number; make: string; model: string; year_start: number | null; year_end: number | null;
  year_label: string; sku: string; notes: string | null;
  documents: { title: string; path: string; last_updated: string } | null;
};

/** Exact lookup. Returns [] when nothing matches — the caller must then say so, not guess. */
export async function lookupFitment(db: SupabaseClient, q: FitmentQuery): Promise<FitmentMatch[]> {
  if (!q.make && !q.model && !q.sku) return [];

  let query = db
    .from("fitment")
    .select("row_number, make, model, year_start, year_end, year_label, sku, notes, documents(title, path, last_updated)");

  // ilike = case-insensitive equality here (wildcard characters are escaped).
  if (q.sku) query = query.ilike("sku", escapeLike(q.sku));
  if (q.make) query = query.ilike("make", escapeLike(q.make));
  if (q.model) query = query.ilike("model", escapeLike(q.model));

  const { data, error } = await query.order("make").order("model").order("year_start");
  if (error) throw new Error(`Fitment lookup failed: ${error.message}`);

  return ((data ?? []) as unknown as FitmentDbRow[])
    .filter((r) => yearInRange(q.year, r.year_start, r.year_end))
    .map((r) => ({
    rowNumber: r.row_number,
    make: r.make,
    model: r.model,
    yearStart: r.year_start,
    yearEnd: r.year_end,
    yearLabel: r.year_label,
    sku: r.sku,
    notes: r.notes,
    documentTitle: r.documents?.title ?? "Fitment list",
    documentPath: r.documents?.path ?? "",
    lastUpdated: r.documents?.last_updated ?? "",
  }));
}

/** Distinct make/model pairs — given to the query planner so it can map "CC Onward" → "Club Car" / "Onward". */
export async function knownCarts(db: SupabaseClient): Promise<string[]> {
  const { data, error } = await db.from("fitment").select("make, model");
  if (error) throw new Error(`Could not load cart list: ${error.message}`);
  const set = new Set((data ?? []).map((r: { make: string; model: string }) => `${r.make} | ${r.model}`));
  return [...set].sort();
}

/** Render lookup results as a plain-text "document" Claude can read and cite. */
export function formatFitmentForClaude(q: FitmentQuery, matches: FitmentMatch[]): string {
  const asked = [q.make, q.model, q.year, q.sku].filter(Boolean).join(" ");
  if (!matches.length) {
    return `Fitment lookup for: ${asked}\nResult: NO MATCHING ROWS in the fitment list. This cart/year/SKU is not listed.`;
  }
  const lines = matches.map(
    (m) =>
      `Row ${m.rowNumber}: ${m.make} ${m.model}, years ${m.yearLabel} → SKU ${m.sku}` +
      (m.notes ? ` (notes: ${m.notes})` : ""),
  );
  return `Fitment lookup for: ${asked}\n${lines.join("\n")}`;
}

// ─── SKU guard ──────────────────────────────────────────────────────
// Code-level backstop for "never guess fitment": any SKU in the answer must
// come from this question's exact fitment lookup, or appear in the quoted
// source text its sentence cites. Otherwise the sentence is removed.

/** Product SKUs are 3–6 dash-separated parts: RDG-CCP-CLR, RDG-CCO-LSV-CLR-WPF-MAG. */
export const SKU_PATTERN = /\b[A-Z]{2,5}(?:-[A-Z0-9]{2,5}){2,5}\b/g;

export const skusIn = (s: string): string[] => [...new Set(s.toUpperCase().match(SKU_PATTERN) ?? [])];

export function guardSkus(segments: CitedSegment[], lookupSkus: string[]): GuardResult {
  const allowed = lookupSkus.map((s) => s.toUpperCase());
  // An option SKU of a matched windshield (RDG-CCO-CLR-WPF for RDG-CCO-CLR) fits the same cart.
  const fromLookup = (sku: string) => allowed.some((base) => sku === base || sku.startsWith(`${base}-`));
  return filterSentences(segments, (sentence, citations) => {
    const quoted = new Set(citations.flatMap((c) => skusIn(c.citedText)));
    const unsupported = skusIn(sentence).filter((sku) => !fromLookup(sku) && !quoted.has(sku));
    return unsupported.length ? `SKU ${unsupported.join(", ")} not in the fitment lookup or cited text` : null;
  });
}
