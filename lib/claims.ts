// ════════════════════════════════════════════════════════════════════
// CLAIMS GUARD — code that checks the model's work
//
// The system prompt tells Claude to make safety/regulatory/performance claims
// only from approved documents. This file doesn't trust that — it checks.
//
// Claude's answer arrives in pieces, each tagged with the exact source text it
// was based on ("citations" — that quoted text is copied from our documents by
// the API, not written by the model). For every sentence that sounds like a
// claim (DOT, UV, impact, "tested", "3x stronger"…) we require:
//   1. the sentence is backed by a citation,
//   2. at least one of those citations comes from an APPROVED document, and
//   3. every number in the sentence appears in that approved quoted text
//      (so "blocks 99% of UV" can't become "blocks 100% of UV").
// Any sentence that fails is removed, and the answer gets a note to contact
// the team for certification/performance details.
// ════════════════════════════════════════════════════════════════════

export const CLAIM_PATTERN =
  /\b(DOT|FMVSS|ANSI|SAE|Z26(\.1)?|AS-?[1-9]|UV|ultra-?violet|impact|shatter\w*|unbreakable|bullet|airflow|aerodynamic\w*|drag|wind noise|certif\w*|complian\w*|conform\w*|street[- ]legal|tested|lab|rated|rating|stronger|strength|times (stronger|tougher)|\d+x (stronger|tougher|thicker))\b/i;
// Note: a bare percentage is NOT a claim on its own ("15% restocking fee" is pricing).
// Percentages inside a claim sentence ("blocks 99% of UV") are still number-checked.

export interface Citation {
  citedText: string;
  approvedForClaims: boolean;
}

export interface CitedSegment {
  text: string;
  citations: Citation[];
}

/** Returns a reason to remove the sentence, or null to keep it. */
export type SentenceCheck = (sentence: string, citations: Citation[]) => string | null;

export interface GuardResult {
  segments: CitedSegment[];
  removed: { sentence: string; reason: string }[];
}

const numbersIn = (s: string): string[] => s.match(/\d+(?:\.\d+)?/g) ?? [];

/** "I don't have an approved figure for that" mentions a claim topic but makes no claim. */
const DECLINES_TO_CLAIM =
  /\b(don'?t|do not|can'?t|cannot|couldn'?t|unable to|not able to)\b[^.!?]*\b(have|find|confirm|quote|share|provide|see|verify)\b|\bno approved\b/i;

/**
 * Product and line NAMES that contain a rating ("AS-4 Premium", "the AS-4 line") identify a
 * product; they don't claim anything. They're blanked out before looking for claims, so
 * "RDG-CCO-CLR (AS-4 Premium) fits your Onward" isn't mistaken for a safety claim, while
 * "it's AS-4 rated" or "AS-4 compliant" still is.
 */
const PRODUCT_NAMES = /\bAS-?4 (Premium( Windshield)?|line|polycarbonate line|product line)\b/gi;

const checkClaim: SentenceCheck = (rawSentence, citations) => {
  const sentence = rawSentence.replace(PRODUCT_NAMES, "");
  if (!CLAIM_PATTERN.test(sentence)) return null;
  if (DECLINES_TO_CLAIM.test(sentence) && !/\d/.test(sentence)) return null;
  if (!citations.length) return "claim with no citation";
  const approved = citations.filter((c) => c.approvedForClaims);
  if (!approved.length) return "claim cited only from non-approved document(s)";
  const source = approved.map((c) => c.citedText).join(" ");
  const missing = numbersIn(sentence).filter((n) => !numbersIn(source).includes(n));
  if (missing.length) return `number(s) ${missing.join(", ")} not found in the approved source text`;
  return null;
};

/** Sentence boundaries: . ! ? followed by whitespace or the end (so "Z26.1" and "3.5" don't split). */
function sentenceRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (/[.!?]/.test(text[i]!) && (i + 1 === text.length || /\s/.test(text[i + 1]!))) {
      let end = i + 1;
      while (end < text.length && /\s/.test(text[end]!)) end++;
      ranges.push([start, end]);
      start = end;
      i = end - 1;
    }
  }
  if (start < text.length) ranges.push([start, text.length]);
  return ranges;
}

/**
 * Claude's answer arrives as segments that can split a sentence ("On UV, yes: " + "it blocks
 * 99%…"[cited]). So we judge whole SENTENCES, each carrying the citations of every segment it
 * overlaps, then cut the rejected sentences back out of the segments.
 * Shared by the claims guard (below) and the dealer-pricing guard (dealer.ts).
 */
export function filterSentences(segments: CitedSegment[], check: SentenceCheck): GuardResult {
  const removed: GuardResult["removed"] = [];
  const full = segments.map((s) => s.text).join("");
  const spans: { start: number; end: number; seg: CitedSegment }[] = [];
  let pos = 0;
  for (const seg of segments) {
    spans.push({ start: pos, end: pos + seg.text.length, seg });
    pos += seg.text.length;
  }

  const cut: [number, number][] = [];
  for (const [s, e] of sentenceRanges(full)) {
    const sentence = full.slice(s, e).trim();
    if (!sentence) continue;
    const citations = spans
      .filter((sp) => sp.start < e && sp.end > s && full.slice(Math.max(sp.start, s), Math.min(sp.end, e)).trim())
      .flatMap((sp) => sp.seg.citations);
    const reason = check(sentence, citations);
    if (reason) {
      removed.push({ sentence, reason });
      cut.push([s, e]);
    }
  }

  const kept = spans.map(({ start, seg }) => {
    let text = "";
    for (let i = 0; i < seg.text.length; i++) {
      const at = start + i;
      if (!cut.some(([s, e]) => at >= s && at < e)) text += seg.text[i];
    }
    return { ...seg, text };
  });
  return { segments: kept, removed };
}

export const guardClaims = (segments: CitedSegment[]) => filterSentences(segments, checkClaim);
