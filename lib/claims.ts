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
// Note: a bare percentage is NOT a claim on its own ("35% dealer discount" is pricing).
// Percentages inside a claim sentence ("blocks 99% of UV") are still number-checked.

export interface CitedSegment {
  text: string;
  citations: { citedText: string; approvedForClaims: boolean }[];
}

export interface GuardResult {
  segments: CitedSegment[];
  removed: { sentence: string; reason: string }[];
}

const numbersIn = (s: string): string[] => s.match(/\d+(?:\.\d+)?/g) ?? [];

function checkSentence(sentence: string, citations: CitedSegment["citations"]): string | null {
  if (!CLAIM_PATTERN.test(sentence)) return null;
  if (!citations.length) return "claim with no citation";
  const approved = citations.filter((c) => c.approvedForClaims);
  if (!approved.length) return "claim cited only from non-approved document(s)";
  const source = approved.map((c) => c.citedText).join(" ");
  const missing = numbersIn(sentence).filter((n) => !numbersIn(source).includes(n));
  if (missing.length) return `number(s) ${missing.join(", ")} not found in the approved source text`;
  return null;
}

export function guardClaims(segments: CitedSegment[]): GuardResult {
  const removed: GuardResult["removed"] = [];
  const kept = segments.map((seg) => {
    // Split the segment into sentences but keep the whitespace between them.
    const parts = seg.text.split(/(?<=[.!?])(\s+)/);
    const out = parts.filter((part) => {
      if (!part.trim()) return true;
      const reason = checkSentence(part, seg.citations);
      if (reason) removed.push({ sentence: part.trim(), reason });
      return !reason;
    });
    return { ...seg, text: out.join("") };
  });
  return { segments: kept, removed };
}
