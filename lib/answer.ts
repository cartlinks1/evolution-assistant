// ════════════════════════════════════════════════════════════════════
// ANSWER — the full pipeline for one question
//
//  1. PLAN      rewrite follow-ups into a standalone question; pull out fitment details
//  2. RETRIEVE  hybrid search + rerank (audience-filtered in the database)
//  3. LOOKUP    exact fitment lookup, if the question is about fitment
//  4. GATE      nothing relevant found? → escalate WITHOUT calling Claude
//  5. GENERATE  Claude answers from the documents only, with API citations
//  6. CHECK     citations required; claims guard; decide answered / escalated
// ════════════════════════════════════════════════════════════════════

import Anthropic from "@anthropic-ai/sdk";
import { guardClaims, type CitedSegment } from "./claims";
import { PRICING, config } from "./config";
import { formatFitmentForClaude, knownCarts, lookupFitment, type FitmentMatch } from "./fitment";
import { planQuery, type ChatTurn, type QueryPlan } from "./planner";
import { NO_ANSWER_MARKER, SYSTEM_PROMPT } from "./prompt";
import { retrieve, type RetrievalResult } from "./retrieval";
import { db } from "./supabase";

export type AnswerStatus = "answered" | "clarifying" | "escalated";
export type EscalationReason =
  | "no_relevant_sources"
  | "model_could_not_answer"
  | "no_citations"
  | "refusal";

export interface Source {
  n: number;
  title: string;
  path: string;
  section: string | null;
  audience: string;
  approvedForClaims: boolean;
  lastUpdated: string;
  citedText: string[];
}

export interface AnswerResult {
  status: AnswerStatus;
  escalationReason?: EscalationReason;
  /** Final answer text with [n] citation markers. */
  text: string;
  sources: Source[];
  plan: QueryPlan;
  retrieval: RetrievalResult;
  fitment: { attempted: boolean; matches: FitmentMatch[] };
  claimsRemoved: { sentence: string; reason: string }[];
  usage: { model: string; inputTokens: number; outputTokens: number; costUsd: number };
}

export const escalationMessage = () =>
  `Our team can help with that. Call us at ${config.contact.phone}, or share your name, email, ` +
  `and your cart's make, model, and year, and we'll get back to you.`;

/** A document handed to Claude, and where it came from (for the sources list). */
interface ProvidedDoc {
  title: string;
  context: string;
  data: string;
  source: Omit<Source, "n" | "citedText">;
}

let anthropic: Anthropic | null = null;
const client = () => (anthropic ??= new Anthropic({ apiKey: config.anthropicApiKey() }));

export async function answerQuestion(opts: {
  question: string;
  history?: ChatTurn[];
  /** Must come from a verified login on the server — never from user input. */
  includeDealer?: boolean;
}): Promise<AnswerResult> {
  const { question, history = [], includeDealer = false } = opts;
  const usage = { model: config.claudeModel, inputTokens: 0, outputTokens: 0, costUsd: 0 };

  // 1. PLAN
  const carts = await knownCarts(db(), includeDealer);
  const plan = await planQuery(client(), question, history, carts);
  usage.inputTokens += plan.usage.input;
  usage.outputTokens += plan.usage.output;

  // 2. RETRIEVE + 3. LOOKUP (in parallel)
  const fitmentQuery = plan.fitment;
  const attempted = !!(fitmentQuery && (fitmentQuery.make || fitmentQuery.model || fitmentQuery.sku));
  const [retrieval, matches] = await Promise.all([
    retrieve(plan.standalone_question, includeDealer),
    attempted ? lookupFitment(db(), fitmentQuery!, includeDealer) : Promise.resolve([]),
  ]);

  const base = { plan, retrieval, fitment: { attempted, matches }, claimsRemoved: [] };

  // 4. GATE — nothing relevant and no fitment lookup: don't ask Claude to improvise.
  if (!retrieval.relevant.length && !attempted) {
    return finish({ ...base, status: "escalated", escalationReason: "no_relevant_sources", text: escalationMessage(), sources: [], usage });
  }

  // 5. GENERATE
  const docs: ProvidedDoc[] = [];
  if (attempted) {
    const first = matches[0];
    docs.push({
      title: first ? `Fitment lookup (${first.documentTitle})` : "Fitment lookup",
      context: `Structured fitment data. Last updated: ${first?.lastUpdated || "n/a"}`,
      data: formatFitmentForClaude(fitmentQuery!, matches),
      source: {
        title: first?.documentTitle ?? "Fitment list",
        path: first?.documentPath ?? "",
        section: matches.length ? `Rows ${matches.map((m) => m.rowNumber).join(", ")}` : "No matching rows",
        audience: "public",
        approvedForClaims: false,
        lastUpdated: first?.lastUpdated ?? "",
      },
    });
  }
  for (const c of retrieval.relevant) {
    docs.push({
      title: c.documentTitle + (c.section ? ` › ${c.section}` : ""),
      context: [
        `Audience: ${c.audience}`,
        `Approved for claims: ${c.approvedForClaims ? "yes" : "no"}`,
        `Last updated: ${c.lastUpdated}`,
      ].join(" · "),
      data: c.content,
      source: {
        title: c.documentTitle,
        path: c.documentPath,
        section: c.section,
        audience: c.audience,
        approvedForClaims: c.approvedForClaims,
        lastUpdated: c.lastUpdated,
      },
    });
  }

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...history.map((t) => ({ role: t.role, content: t.content })),
    {
      role: "user",
      content: [
        ...docs.map(
          (d): Anthropic.Beta.BetaRequestDocumentBlock => ({
            type: "document",
            source: { type: "text", media_type: "text/plain", data: d.data },
            title: d.title,
            context: d.context,
            citations: { enabled: true },
          }),
        ),
        { type: "text", text: plan.standalone_question === question ? question : `${question}\n\n(Interpreted as: ${plan.standalone_question})` },
      ],
    },
  ];

  const response = await client().beta.messages.create({
    model: config.claudeModel,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages,
    output_config: { effort: "medium" },
    // If Claude's safety classifiers decline a request, retry automatically on
    // Anthropic's recommended fallback model instead of failing.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
  usage.inputTokens += response.usage.input_tokens;
  usage.outputTokens += response.usage.output_tokens;

  if (response.stop_reason === "refusal") {
    return finish({ ...base, status: "escalated", escalationReason: "refusal", text: escalationMessage(), sources: [], usage });
  }

  // 6. CHECK — collect text + citations, run the claims guard, assign [n] markers.
  const segments: (CitedSegment & { docIndexes: number[] })[] = [];
  for (const block of response.content) {
    if (block.type !== "text") continue;
    const cites = (block.citations ?? []).flatMap((c) =>
      c.type === "char_location" ? [{ docIndex: c.document_index, citedText: c.cited_text }] : [],
    );
    segments.push({
      text: block.text,
      docIndexes: cites.map((c) => c.docIndex),
      citations: cites.map((c) => ({
        citedText: c.citedText,
        approvedForClaims: docs[c.docIndex]?.source.approvedForClaims ?? false,
      })),
    });
  }

  const fullText = segments.map((s) => s.text).join("");
  const couldNotAnswer = fullText.includes(NO_ANSWER_MARKER);
  for (const s of segments) s.text = s.text.replaceAll(NO_ANSWER_MARKER, "");

  const guarded = guardClaims(segments);

  const sources: Source[] = [];
  const numberFor = new Map<number, number>();
  let text = "";
  guarded.segments.forEach((seg, i) => {
    text += seg.text;
    const idxs = [...new Set(segments[i]!.docIndexes)];
    if (!seg.text.trim() || !idxs.length) return;
    const marks = idxs.map((docIndex) => {
      if (!numberFor.has(docIndex)) {
        numberFor.set(docIndex, sources.length + 1);
        sources.push({ n: sources.length + 1, ...docs[docIndex]!.source, citedText: [] });
      }
      const src = sources[numberFor.get(docIndex)! - 1]!;
      for (const c of segments[i]!.citations) if (!src.citedText.includes(c.citedText)) src.citedText.push(c.citedText);
      return `[${numberFor.get(docIndex)}]`;
    });
    text = text.trimEnd() + marks.join("") + (seg.text.match(/\s+$/)?.[0] ?? "");
  });
  text = text.trim();

  if (guarded.removed.length) {
    text += `\n\nFor certification and performance details, please contact our team at ${config.contact.phone}.`;
  }

  if (couldNotAnswer) {
    return finish({
      ...base, claimsRemoved: guarded.removed, status: "escalated", escalationReason: "model_could_not_answer",
      text: `${text}\n\n${escalationMessage()}`.trim(), sources, usage,
    });
  }
  if (!sources.length) {
    // No citations at all. A clarifying question ("Which year is your cart?") is fine;
    // an uncited factual answer is not — we don't show it.
    if (text.endsWith("?")) {
      return finish({ ...base, claimsRemoved: guarded.removed, status: "clarifying", text, sources, usage });
    }
    return finish({
      ...base, claimsRemoved: guarded.removed, status: "escalated", escalationReason: "no_citations",
      text: `I couldn't confirm that from our documents. ${escalationMessage()}`, sources, usage,
    });
  }
  return finish({ ...base, claimsRemoved: guarded.removed, status: "answered", text, sources, usage });
}

function finish(r: AnswerResult): AnswerResult {
  const price = PRICING[r.usage.model];
  if (price) {
    r.usage.costUsd = (r.usage.inputTokens * price.input + r.usage.outputTokens * price.output) / 1_000_000;
  }
  return r;
}
