// ════════════════════════════════════════════════════════════════════
// ASK — command-line window into the whole pipeline
//
//   npm run ask -- "Does the clear windshield fit a 2019 Club Car Precedent?"
//   npm run ask                  → chat mode: follow-up questions keep context
//   npm run ask -- --dealer ...  → include dealer-only documents
//   npm run ask -- --brief ...   → answer + sources only, no retrieval details
//
// (--dealer exists because this is YOUR local admin tool. In the web app,
//  dealer access comes only from a verified login, never from a flag.)
// ════════════════════════════════════════════════════════════════════

import { createInterface } from "node:readline/promises";
import { answerQuestion, type AnswerResult } from "../lib/answer";
import { config } from "../lib/config";
import type { ChatTurn } from "../lib/planner";

const args = process.argv.slice(2);
const includeDealer = args.includes("--dealer");
const brief = args.includes("--brief");
const questionArg = args.filter((a) => !a.startsWith("--")).join(" ").trim();

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const color = { answered: "\x1b[32m", clarifying: "\x1b[36m", escalated: "\x1b[33m" } as const;
const fmt = (n: number | null | undefined, digits = 3) => (n == null ? "—" : n.toFixed(digits));
const preview = (s: string, n = 70) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

function print(r: AnswerResult) {
  const status = `${color[r.status]}${r.status.toUpperCase()}${r.escalationReason ? ` (${r.escalationReason})` : ""}\x1b[0m`;
  console.log(`\n${bold("Answer")} ${status}\n`);
  console.log(r.text);

  if (r.sources.length) {
    console.log(`\n${bold("Sources")}`);
    for (const s of r.sources) {
      const tags = [s.audience, s.approvedForClaims ? "approved for claims" : null, s.lastUpdated && `updated ${s.lastUpdated}`]
        .filter(Boolean)
        .join(" · ");
      console.log(`  [${s.n}] ${s.title}${s.section ? ` › ${s.section}` : ""}  ${dim(`(${s.path} · ${tags})`)}`);
      for (const q of s.citedText.slice(0, 3)) console.log(dim(`      "${preview(q, 110)}"`));
    }
  }

  if (r.claimsRemoved.length) {
    console.log(`\n${bold("⚠ Claims guard removed:")}`);
    for (const c of r.claimsRemoved) console.log(`  - "${c.sentence}"  ${dim(`→ ${c.reason}`)}`);
  }

  if (!brief) {
    console.log(`\n${bold("How it got there")}`);
    console.log(`  Search question: ${r.plan.standalone_question}`);
    if (r.fitment.attempted) {
      const f = r.plan.fitment!;
      console.log(
        `  Fitment lookup:  make=${f.make ?? "—"} model=${f.model ?? "—"} year=${f.year ?? "—"} sku=${f.sku ?? "—"}` +
          ` → ${r.fitment.matches.length} row(s)` +
          (r.fitment.matches.length ? `: ${r.fitment.matches.map((m) => `${m.sku} (${m.yearLabel})`).join(", ")}` : ""),
      );
    } else {
      console.log(`  Fitment lookup:  not a fitment question`);
    }

    const used = new Set(r.retrieval.relevant.map((c) => c.chunkId));
    console.log(
      `\n  Retrieved chunks — sorted by reranker score. "used" = cleared the ${config.relevanceThreshold} relevance bar and was shown to Claude.`,
    );
    console.log(dim(`  rerank = how well the chunk answers the question (0–1) · vector = meaning similarity · keyword = word-match score · rrf = merged search rank\n`));
    console.table(
      r.retrieval.candidates.slice(0, 12).map((c) => ({
        used: used.has(c.chunkId) ? "✓" : "",
        rerank: fmt(c.rerankScore),
        vector: fmt(c.vectorSimilarity),
        keyword: fmt(c.keywordScore),
        rrf: fmt(c.rrfScore, 4),
        aud: c.audience,
        chunk: preview(`${c.documentTitle}${c.section ? ` › ${c.section}` : ""}: ${c.content}`),
      })),
    );
  }

  console.log(
    dim(
      `  ${r.usage.model} · ${r.usage.inputTokens.toLocaleString()} in / ${r.usage.outputTokens.toLocaleString()} out tokens · ≈ $${r.usage.costUsd.toFixed(4)}` +
        (includeDealer ? " · DEALER MODE" : ""),
    ),
  );
}

async function main() {
  if (questionArg) {
    print(await answerQuestion({ question: questionArg, includeDealer }));
    return;
  }

  // Chat mode — keeps a short conversation history so follow-ups work.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const history: ChatTurn[] = [];
  console.log(`Ask a question (empty line to quit)${includeDealer ? " — DEALER MODE" : ""}.`);
  for (;;) {
    const q = (await rl.question("\n› ")).trim();
    if (!q) break;
    try {
      const r = await answerQuestion({ question: q, history, includeDealer });
      print(r);
      history.push({ role: "user", content: q }, { role: "assistant", content: r.text });
    } catch (e) {
      console.error(`✗ ${(e as Error).message}`);
    }
  }
  rl.close();
}

main().catch((e) => {
  console.error(`\n✗ ${(e as Error).message}\n`);
  process.exit(1);
});
