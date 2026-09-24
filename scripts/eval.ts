// ════════════════════════════════════════════════════════════════════
// EVAL — run the test questions through the real assistant and grade them
//
//   npm run eval                          all cases, once each → data/eval/runs/baseline/
//   npm run eval -- --only fit-drive2,claim-uv   just these cases
//   npm run eval -- --limit 5             first 5 cases (a cheap pilot)
//   npm run eval -- --variant v1          save as a new run to compare against baseline
//   npm run eval -- --reps 2              ask every question twice
//
// It calls answerQuestion() — the exact code customers will hit — then grades
// each answer (lib/eval/grade.ts). Results are written as each case finishes,
// so a crash loses nothing and re-running the same command resumes where it
// stopped. Everything lands in data/eval/ (private, never committed).
// ════════════════════════════════════════════════════════════════════

import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { answerQuestion, type AnswerResult } from "../lib/answer";
import { PRICING, config } from "../lib/config";
import { checkBehavior, checkContent, judge, verdict, JUDGE_MODEL, type EvalCase, type JudgeResult, type Verdict } from "../lib/eval/grade";
import { systemPrompt } from "../lib/prompt";

// ─── Options ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const casesPath = opt("cases", "data/eval/cases.json");
const flowDir = opt("out", "data/eval/runs");
const variant = opt("variant", "baseline");
const reps = Number(opt("reps", "1"));
const limit = Number(opt("limit", "0"));
const only = opt("only", "").split(",").filter(Boolean);
const concurrency = Number(opt("concurrency", "3"));
const timeoutMs = Number(opt("timeout-s", "180")) * 1000;

if (!/^(baseline|v\d+)$/.test(variant)) {
  console.error(`--variant must be "baseline" or v1, v2, … (got "${variant}")`);
  process.exit(1);
}

// ─── Setup ──────────────────────────────────────────────────────────
let cases = JSON.parse(readFileSync(casesPath, "utf8")) as EvalCase[];
if (only.length) cases = cases.filter((c) => only.includes(c.id));
if (limit) cases = cases.slice(0, limit);

const runDir = path.join(flowDir, variant);
const tracesDir = path.join(runDir, "traces");
mkdirSync(tracesDir, { recursive: true });
const resultsFile = path.join(runDir, "results.jsonl");
const errorsFile = path.join(runDir, "errors.jsonl");

// Metric declarations for the report (first binary metric = headline).
const stateFile = path.join(flowDir, "_state.json");
if (!existsSync(stateFile)) {
  writeFileSync(
    stateFile,
    JSON.stringify(
      {
        metrics: [
          { id: "pass", label: "Pass", kind: "binary" },
          { id: "not_made_up", label: "Not made up", kind: "binary" },
          { id: "behavior", label: "Behavior", kind: "binary" },
          { id: "content", label: "Content", kind: "binary" },
          { id: "matches", label: "Matches exp.", kind: "binary" },
        ],
        perf_fields: [
          { key: "cost_usd", label: "Cost $" },
          { key: "latency_s", label: "Latency s" },
        ],
      },
      null,
      2,
    ),
  );
}

// Resume: skip (case, rep) pairs already graded.
const done = new Set<string>();
if (existsSync(resultsFile)) {
  for (const line of readFileSync(resultsFile, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line) as { prompt_id: string; rep: number };
    done.add(`${r.prompt_id}#${r.rep}`);
  }
}

const jobs = cases.flatMap((c) => Array.from({ length: reps }, (_, rep) => ({ c, rep }))).filter(({ c, rep }) => !done.has(`${c.id}#${rep}`));
const client = new Anthropic({ apiKey: config.anthropicApiKey() });

const price = (model: string, usage: { input_tokens: number; output_tokens: number }) => {
  const p = PRICING[model];
  return p ? (usage.input_tokens * p.input + usage.output_tokens * p.output) / 1_000_000 : 0;
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
  });
  // Clear the timer either way, or it keeps the process alive after the run finishes.
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// ─── One case ───────────────────────────────────────────────────────
interface Row {
  prompt_id: string;
  rep: number;
  verdict: Verdict;
  category: string;
  reasons: string[];
  cost_usd: number;
}

async function runOne(c: EvalCase, rep: number): Promise<Row | null> {
  let answer: AnswerResult;
  try {
    answer = await withTimeout(answerQuestion({ question: c.question, history: c.history ?? [] }), timeoutMs);
  } catch (e) {
    const msg = (e as Error).message;
    appendFileSync(errorsFile, JSON.stringify({ prompt_id: c.id, rep, failure_class: /timed out/.test(msg) ? "timeout" : "harness_error", message: msg }) + "\n");
    return null;
  }

  const behavior = checkBehavior(c, answer);
  const content = checkContent(c, answer.text);

  // Fixed replies (dealer reply, "nothing relevant found") use no documents and contain only
  // app-written text, so there's nothing for the judge to check.
  let j: JudgeResult;
  let judgeModel: string | null = null;
  let judgeUsage = { input_tokens: 0, output_tokens: 0 };
  if (!answer.context.length) {
    j = { unsupported_statements: [], matches_expected: behavior.ok ? "yes" : "no", explanation: "Fixed reply with no documents; judged on behavior alone." };
  } else {
    try {
      const out = await judge(client, c, answer);
      j = out.result;
      judgeModel = out.model;
      judgeUsage = out.usage;
    } catch (e) {
      appendFileSync(errorsFile, JSON.stringify({ prompt_id: c.id, rep, failure_class: "grader_error", message: (e as Error).message, model: answer.servedModel, usage: answer.usage }) + "\n");
      return null;
    }
  }

  const v = verdict(behavior, content, j);
  const answerModel = answer.servedModel ?? answer.usage.model;
  const answerUsage = { input_tokens: answer.usage.inputTokens, output_tokens: answer.usage.outputTokens };
  const cost = price(answer.usage.model, answerUsage) + (judgeModel ? price(JUDGE_MODEL, judgeUsage) : 0);

  const row = {
    prompt_id: c.id,
    rep,
    prompt: c.question,
    tags: [c.category, `expects: ${c.expect}`],
    status: "ok",
    verdict: v.verdict,
    grade: {
      pass: v.verdict === "PASS" ? 1 : 0,
      not_made_up: v.verdict === "MADE UP" ? 0 : 1,
      behavior: behavior.ok ? 1 : 0,
      content: content.ok ? 1 : 0,
      matches: j.matches_expected === "yes" ? 1 : j.matches_expected === "partly" ? 0.5 : 0,
    },
    explanation: { pass: v.reasons.join(" | ") || "ok", matches: j.explanation },
    answer: answer.text,
    answer_status: answer.status,
    escalation_reason: answer.escalationReason ?? null,
    model: answerModel,
    requested_model: config.claudeModel,
    usage: answerUsage,
    judge_model: judgeModel,
    judge_usage: judgeUsage,
    cost_usd: Number(cost.toFixed(5)),
    latency_s: Number((answer.latencyMs / 1000).toFixed(2)),
    meta: { expected: c.expected_answer, unsupported: j.unsupported_statements, sources: answer.sources.map((s) => s.title) },
  };

  // Full transcript for click-through: what Claude saw, and what it said.
  const trace = [
    { role: "system", content: systemPrompt() },
    ...(c.history ?? []).map((t) => ({ role: t.role, content: t.content })),
    {
      role: "user",
      content:
        c.question +
        (answer.context.length
          ? `\n\n── Documents given to the assistant ──\n${answer.context.map((d, i) => `[${i + 1}] ${d.title}\n${d.text}`).join("\n\n")}`
          : "\n\n(no documents: fixed reply)"),
    },
    { role: "assistant", content: answer.text },
    {
      role: "tool_result",
      name: "grader",
      content: JSON.stringify({ verdict: v.verdict, reasons: v.reasons, behavior, content, judge: j }, null, 2),
    },
  ];
  writeFileSync(path.join(tracesDir, `${c.id}_rep${rep}.json`), JSON.stringify(trace, null, 2));
  appendFileSync(resultsFile, JSON.stringify(row) + "\n");

  const icon = v.verdict === "PASS" ? "✅" : v.verdict === "MADE UP" ? "🔴" : "🟠";
  console.log(`${icon} ${v.verdict.padEnd(7)} ${c.id}${reps > 1 ? ` (rep ${rep})` : ""}${v.reasons.length ? `\n     ${v.reasons.join("\n     ")}` : ""}`);
  return { prompt_id: c.id, rep, verdict: v.verdict, category: c.category, reasons: v.reasons, cost_usd: row.cost_usd };
}

// ─── Run with bounded concurrency ───────────────────────────────────
async function main() {
  console.log(`\nRunning ${jobs.length} answer(s) → ${runDir}/  (answers: ${config.claudeModel}, grader: ${JUDGE_MODEL})\n`);
  const started = Date.now();
  const queue = [...jobs];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) await runOne(job.c, job.rep);
  });
  await Promise.all(workers);

  // Summary over everything in results.jsonl (includes earlier resumed rows).
  const all = existsSync(resultsFile)
    ? readFileSync(resultsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { verdict: Verdict; tags: string[]; cost_usd: number })
    : [];
  const count = (v: Verdict, rows = all) => rows.filter((r) => r.verdict === v).length;
  const n = all.length;
  const pct = (k: number, of = n) => (of ? `${Math.round((100 * k) / of)}%` : "—");
  // Rough 95% margin of error on a pass rate (≈ 1/√n): smaller differences between runs are noise.
  const moe = n ? Math.round(100 / Math.sqrt(n)) : 0;

  console.log(`\n━━ ${variant}: ${n} graded answer(s) ━━`);
  console.log(`✅ PASS     ${count("PASS")}  (${pct(count("PASS"))}, ±${moe} points)`);
  console.log(`🟠 FAIL     ${count("FAIL")}`);
  console.log(`🔴 MADE UP  ${count("MADE UP")}`);
  const cats = [...new Set(all.map((r) => r.tags[0]!))];
  console.table(
    cats.map((cat) => {
      const rows = all.filter((r) => r.tags[0] === cat);
      return { topic: cat, answers: rows.length, pass: count("PASS", rows), fail: count("FAIL", rows), "made up": count("MADE UP", rows) };
    }),
  );
  const errors = existsSync(errorsFile) ? readFileSync(errorsFile, "utf8").split("\n").filter(Boolean).length : 0;
  const cost = all.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  console.log(`Cost ≈ $${cost.toFixed(2)} · ${((Date.now() - started) / 1000).toFixed(0)}s this run${errors ? ` · ⚠ ${errors} error(s) in errors.jsonl (not scored)` : ""}\n`);
}

main().catch((e) => {
  console.error(`\n✗ ${(e as Error).message}\n`);
  process.exit(1);
});
