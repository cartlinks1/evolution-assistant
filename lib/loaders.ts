// Turns a file on disk into chunks (and, for fitment CSVs, structured rows).

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import { extractText, getDocumentProxy } from "unpdf";
import { chunkCsvRows, chunkMarkdown, chunkPdfPages, wordCount } from "./chunking";
import { isFitmentCsv, parseFitmentRows } from "./fitment";
import type { DraftChunk, FitmentRow } from "./types";

export const SUPPORTED_EXTENSIONS = [".md", ".markdown", ".txt", ".pdf", ".csv"];

export interface LoadedFile {
  chunks: DraftChunk[];
  fitment: FitmentRow[] | null;
  warnings: string[];
}

export async function loadFile(absPath: string): Promise<LoadedFile> {
  const ext = path.extname(absPath).toLowerCase();
  const warnings: string[] = [];

  if (ext === ".md" || ext === ".markdown" || ext === ".txt") {
    return { chunks: chunkMarkdown(await readFile(absPath, "utf8")), fitment: null, warnings };
  }

  if (ext === ".pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(await readFile(absPath)));
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [text];
    const words = pages.reduce((n, p) => n + wordCount(p), 0);
    // A scanned PDF is a picture of text — there's nothing to extract without OCR.
    if (words < totalPages * 15) {
      warnings.push(
        `Only ${words} words found across ${totalPages} page(s) — this PDF may be a scan. ` +
          `It needs OCR (or a text version) before it can be searched.`,
      );
    }
    return { chunks: chunkPdfPages(pages), fitment: null, warnings };
  }

  if (ext === ".csv") {
    const rows = parseCsv(await readFile(absPath, "utf8"), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    }) as Record<string, string>[];
    const headers = rows.length ? Object.keys(rows[0]!) : [];

    if (isFitmentCsv(headers)) {
      const fitment = parseFitmentRows(rows);
      if (fitment.length < rows.length) {
        warnings.push(`${rows.length - fitment.length} row(s) skipped: missing make or model.`);
      }
      // One overview chunk so broad questions ("what carts do you fit?") can still be found by search.
      // Product names only — SKUs are never shown to customers, so they're kept out of search text too.
      const carts = [...new Set(fitment.map((r) => `${r.make} ${r.model}${r.yearLabel !== "not specified" ? ` (${r.yearLabel})` : ""}`))];
      const products = [...new Set(fitment.map((r) => r.product).filter(Boolean))];
      const overview: DraftChunk = {
        section: "Overview",
        content:
          `Fitment list covering ${carts.length} cart models: ${carts.join(", ")}.\n` +
          (products.length ? `Products in this list: ${products.join("; ")}.\n` : "") +
          `For a specific cart and year, use the exact fitment lookup.`,
      };
      return { chunks: fitment.length ? [overview] : [], fitment, warnings };
    }
    return { chunks: chunkCsvRows(rows), fitment: null, warnings };
  }

  throw new Error(`Unsupported file type: ${ext}`);
}
