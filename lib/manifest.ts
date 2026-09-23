// ════════════════════════════════════════════════════════════════════
// MANIFEST — the metadata tags for each document
//
// manifest.csv sits at the top of the data folder. One row per file:
//
//   file,title,last_updated,approved_for_claims,exclude
//   install-guide.pdf,Installation Guide,2026-03-01,true,false
//
// Rules (safe by default):
//   • approved_for_claims defaults to FALSE when missing or unreadable.
//   • exclude=true means "never ingest this file" (e.g. outdated pages).
//   • last_updated falls back to the file's modified date if blank.
// ════════════════════════════════════════════════════════════════════

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseCsv } from "csv-parse/sync";

export interface ManifestEntry {
  title?: string;
  lastUpdated?: string;
  approvedForClaims: boolean;
  exclude: boolean;
}

const truthy = (v: string | undefined) => /^(true|yes|y|1|x)$/i.test((v ?? "").trim());

export async function readManifest(dataDir: string): Promise<Map<string, ManifestEntry>> {
  const file = path.join(dataDir, "manifest.csv");
  const map = new Map<string, ManifestEntry>();
  if (!existsSync(file)) return map;

  const rows = parseCsv(await readFile(file, "utf8"), {
    columns: (h: string[]) => h.map((c) => c.trim().toLowerCase()),
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as Record<string, string>[];

  for (const r of rows) {
    if (!r.file) continue;
    const date = r.last_updated?.trim();
    map.set(normalizePath(r.file), {
      title: r.title?.trim() || undefined,
      lastUpdated: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
      approvedForClaims: truthy(r.approved_for_claims),
      exclude: truthy(r.exclude),
    });
  }
  return map;
}

export const normalizePath = (p: string) => p.trim().replace(/\\/g, "/").replace(/^\.?\//, "").toLowerCase();

/** "install-guide_v2.pdf" → "Install Guide V2" */
export function titleFromFilename(file: string): string {
  return path
    .basename(file, path.extname(file))
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
