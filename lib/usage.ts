// ════════════════════════════════════════════════════════════════════
// USAGE LIMITS & QUESTION LOG — cost protection for the public chat
//
// Before a website question reaches Claude, three limits are checked:
//   • per visitor:  a few questions per minute, and a daily maximum
//   • everyone:     a daily maximum across all visitors
//   • money:        a monthly budget (sum of logged answer costs)
// If any is hit, the visitor gets the email/phone reply and NO paid API call
// is made. This sits on top of the hard monthly spend limit you set in the
// Anthropic Console, which is the final backstop.
// ════════════════════════════════════════════════════════════════════

import { createHash } from "node:crypto";
import type { AnswerResult } from "./answer";
import { config } from "./config";
import { db } from "./supabase";

export const LIMITS = {
  perVisitorPerMinute: Number(process.env.LIMIT_PER_VISITOR_PER_MINUTE ?? 5),
  perVisitorPerDay: Number(process.env.LIMIT_PER_VISITOR_PER_DAY ?? 40),
  everyonePerDay: Number(process.env.LIMIT_EVERYONE_PER_DAY ?? 500),
  monthlyBudgetUsd: Number(process.env.MONTHLY_BUDGET_USD ?? 50),
  maxQuestionChars: 500,
  maxHistoryTurns: 6,
  maxHistoryChars: 1500,
};

/** Visitors are identified by a salted hash of their IP — the IP itself is never stored. */
export function visitorHash(ip: string): string {
  const salt = process.env.IP_HASH_SALT || config.supabaseSecretKey();
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

export type LimitHit = "visitor_minute" | "visitor_day" | "everyone_day" | "monthly_budget";

export async function checkLimits(hash: string): Promise<LimitHit | null> {
  const { data, error } = await db().rpc("chat_usage", { p_visitor_hash: hash });
  if (error) throw new Error(`Usage check failed: ${error.message}`);
  const u = (data as { visitor_last_minute: number; visitor_today: number; everyone_today: number; cost_this_month: number }[])[0];
  if (!u) return null;
  if (Number(u.cost_this_month) >= LIMITS.monthlyBudgetUsd) return "monthly_budget";
  if (u.everyone_today >= LIMITS.everyonePerDay) return "everyone_day";
  if (u.visitor_last_minute >= LIMITS.perVisitorPerMinute) return "visitor_minute";
  if (u.visitor_today >= LIMITS.perVisitorPerDay) return "visitor_day";
  return null;
}

export async function logQuestion(entry: {
  sessionId: string | null;
  visitorHash: string;
  question: string;
  result?: AnswerResult;
  status?: string;
  escalationReason?: string;
}): Promise<void> {
  const r = entry.result;
  const { error } = await db()
    .from("question_log")
    .insert({
      session_id: entry.sessionId,
      visitor_hash: entry.visitorHash,
      question: entry.question,
      answer: r?.text ?? null,
      status: entry.status ?? r?.status ?? "error",
      escalation_reason: entry.escalationReason ?? r?.escalationReason ?? null,
      sources: r ? r.sources.map((s) => ({ title: s.title, section: s.section })) : null,
      model: r?.servedModel ?? r?.usage.model ?? null,
      input_tokens: r?.usage.inputTokens ?? null,
      output_tokens: r?.usage.outputTokens ?? null,
      cost_usd: r?.usage.costUsd ?? 0,
      latency_ms: r?.latencyMs ?? null,
    });
  // Logging must never break the customer's answer — report and move on.
  if (error) console.error(`question_log insert failed: ${error.message}`);
}
