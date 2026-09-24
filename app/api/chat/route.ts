// ════════════════════════════════════════════════════════════════════
// POST /api/chat — the website's one endpoint
//
//   { question, history?, sessionId? }  →  { text, sources, status }
//
// Order of operations (cheapest checks first, so abuse costs nothing):
//   1. reject requests from other websites (Origin check)
//   2. validate and trim the input (length caps)
//   3. usage limits: per visitor, everyone per day, monthly budget
//   4. answerQuestion() — the same pipeline the CLI and eval use
//   5. log the question and outcome
// ════════════════════════════════════════════════════════════════════

import { answerQuestion, escalationMessage } from "@/lib/answer";
import { config } from "@/lib/config";
import type { ChatTurn } from "@/lib/planner";
import { LIMITS, checkLimits, logQuestion, visitorHash } from "@/lib/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const json = (body: unknown, status = 200) => Response.json(body, { status });

export async function POST(req: Request) {
  try {
    return await handle(req);
  } catch (e) {
    // Anything unexpected (e.g. a missing setting) still gets a helpful reply, never a blank error.
    console.error(e);
    let contact = "";
    try {
      contact = ` ${escalationMessage()}`;
    } catch {}
    return json({ text: `Sorry, something went wrong on our end.${contact}`, sources: [], status: "error" }, 500);
  }
}

async function handle(req: Request): Promise<Response> {
  // 1. Only our own chat page may call this (browsers always send Origin on POST).
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (origin && host && new URL(origin).host !== host) return json({ error: "forbidden" }, 403);

  // 2. Validate input.
  let body: { question?: unknown; history?: unknown; sessionId?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return json({ error: "question is required" }, 400);
  if (question.length > LIMITS.maxQuestionChars) {
    return json({ text: `Please keep questions under ${LIMITS.maxQuestionChars} characters.`, sources: [], status: "invalid" });
  }
  const history: ChatTurn[] = (Array.isArray(body.history) ? body.history : [])
    .filter((t): t is ChatTurn => !!t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
    .slice(-LIMITS.maxHistoryTurns)
    .map((t) => ({ role: t.role, content: t.content.slice(0, LIMITS.maxHistoryChars) }));
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.slice(0, 64) : null;

  // 3. Usage limits — checked before any paid API call.
  const ip =
    req.headers.get("x-nf-client-connection-ip") || // Netlify
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  const hash = visitorHash(ip);
  const hit = await checkLimits(hash).catch((e) => {
    console.error(e);
    return "monthly_budget" as const; // if we can't verify spend, fail closed
  });
  if (hit) {
    const text =
      hit === "visitor_minute"
        ? `You're sending questions quickly. Please wait a minute and try again, or email ${config.contact.email}.`
        : `Our assistant is taking a break right now. ${escalationMessage()}`;
    await logQuestion({ sessionId, visitorHash: hash, question, status: "rate_limited", escalationReason: hit });
    return json({ text, sources: [], status: "limited" });
  }

  // 4. Answer.
  try {
    const result = await answerQuestion({ question, history });
    await logQuestion({ sessionId, visitorHash: hash, question, result });
    return json({
      text: result.text,
      status: result.status,
      sources: result.sources.map((s) => ({ n: s.n, title: s.title, section: s.section, quote: s.citedText[0] ?? null })),
    });
  } catch (e) {
    console.error(e);
    await logQuestion({ sessionId, visitorHash: hash, question, status: "error", escalationReason: (e as Error).message.slice(0, 200) });
    return json({ text: `Sorry, something went wrong on our end. ${escalationMessage()}`, sources: [], status: "error" }, 500);
  }
}
