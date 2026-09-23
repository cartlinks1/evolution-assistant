// ════════════════════════════════════════════════════════════════════
// CHUNKING — cutting documents into searchable pieces
//
// Why chunk at all? When someone asks "how do I clean my windshield?", we
// want to hand Claude the *care section*, not the whole 12-page manual.
// Smaller pieces = more precise search results and cheaper answers.
//
// But pieces that are too small lose their meaning ("Tighten to 5 in-lb" —
// tighten *what*?). So we:
//   1. Split along the document's own structure (headings in Markdown,
//      pages in PDFs, rows in spreadsheets) — authors already grouped related
//      ideas under headings, so we respect that.
//   2. Within a long section, pack whole paragraphs into chunks of ~350
//      words (never more than ~500), never cutting mid-sentence.
//   3. Repeat the last ~50 words of the previous chunk at the start of the
//      next ("overlap"), so a thought that straddles the boundary isn't lost.
//   4. Label every chunk with its document title and heading path before
//      embedding (see ingest.ts), so even a short chunk carries its context.
// ════════════════════════════════════════════════════════════════════

import { config } from "./config";
import type { DraftChunk } from "./types";

/**
 * The text we actually embed and rerank: the chunk plus a short label saying
 * where it came from. "Tighten to 5 in-lb" alone is ambiguous; with
 * "Document: Installation Guide / Section: Mounting the brackets" on top it
 * lands in the right spot on the meaning map. (Claude sees the same label.)
 */
export function withContext(title: string, section: string | null, content: string): string {
  return `Document: ${title}\n${section ? `Section: ${section}\n` : ""}\n${content}`;
}

export const wordCount =(s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

function lastWords(s: string, n: number): string {
  const words = s.trim().split(/\s+/);
  return words.slice(Math.max(0, words.length - n)).join(" ");
}

/** Split an over-long paragraph into sentence-sized pieces. */
function splitLongParagraph(p: string, maxWords: number): string[] {
  if (wordCount(p) <= maxWords) return [p];
  const sentences = p.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [p];
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (buf && wordCount(buf) + wordCount(s) > maxWords) {
      out.push(buf.trim());
      buf = "";
    }
    buf += s;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** Pack paragraphs into chunks near the target size, with overlap between consecutive chunks. */
export function packParagraphs(
  paragraphs: string[],
  section: string | null,
  opts: { target: number; max: number; overlap: number } = {
    target: config.chunkTargetWords,
    max: config.chunkMaxWords,
    overlap: config.chunkOverlapWords,
  },
): DraftChunk[] {
  const pieces = paragraphs.flatMap((p) => splitLongParagraph(p.trim(), opts.max)).filter(Boolean);
  const chunks: DraftChunk[] = [];
  let current: string[] = [];
  let words = 0;

  const flush = () => {
    if (!current.length) return;
    chunks.push({ section, content: current.join("\n\n") });
    const carry = lastWords(current.join(" "), opts.overlap);
    current = [];
    words = 0;
    return carry;
  };

  for (const piece of pieces) {
    const w = wordCount(piece);
    if (words > 0 && (words + w > opts.max || words >= opts.target)) {
      const carry = flush();
      // Only overlap when the section continues; the carried text is marked with "…".
      if (carry) {
        current.push(`…${carry}`);
        words = wordCount(carry);
      }
    }
    current.push(piece);
    words += w;
  }
  flush();
  return chunks;
}

/**
 * Markdown: one section per heading, labelled with its full heading path
 * ("Installation › Step 3: Mount the brackets"). Tiny sections (a heading plus
 * one short line) are kept as-is — they're often exactly the answer.
 */
export function chunkMarkdown(markdown: string): DraftChunk[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const headingPath: string[] = [];
  const sections: { section: string | null; body: string[] }[] = [{ section: null, body: [] }];

  for (const line of lines) {
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      const level = m[1]!.length;
      headingPath.length = level - 1;
      headingPath[level - 1] = m[2]!.trim();
      sections.push({ section: headingPath.filter(Boolean).join(" › "), body: [] });
    } else {
      sections.at(-1)!.body.push(line);
    }
  }

  return sections.flatMap(({ section, body }) => {
    const paragraphs = body
      .join("\n")
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    return paragraphs.length ? packParagraphs(paragraphs, section) : [];
  });
}

/** PDF: text arrives page by page. Each page is packed separately and labelled "Page N". */
export function chunkPdfPages(pages: string[]): DraftChunk[] {
  return pages.flatMap((pageText, i) => {
    const paragraphs = pageText
      .replace(/\r\n/g, "\n")
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
      .filter(Boolean);
    return paragraphs.length ? packParagraphs(paragraphs, `Page ${i + 1}`) : [];
  });
}

/**
 * Generic spreadsheet (not fitment): one chunk per row, written out as
 * "Column: value" pairs so the row reads as a self-contained fact.
 */
export function chunkCsvRows(rows: Record<string, string>[]): DraftChunk[] {
  return rows
    .map((row, i) => ({
      section: `Row ${i + 2}`, // +2: header is row 1, spreadsheets count from 1
      content: Object.entries(row)
        .filter(([, v]) => v?.trim())
        .map(([k, v]) => `${k}: ${v.trim()}`)
        .join("; "),
    }))
    .filter((c) => c.content);
}
