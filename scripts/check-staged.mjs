#!/usr/bin/env node
// Guard against committing real business data or secrets to this PUBLIC repo.
//
// Runs two ways:
//   node scripts/check-staged.mjs         → checks files staged for commit (pre-commit hook)
//   node scripts/check-staged.mjs --all   → checks every tracked file (CI on GitHub)
//
// Plain JS (no TypeScript, no dependencies) so it runs before `npm install`.

import { execFileSync } from "node:child_process";

const all = process.argv.includes("--all");

const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const files = (all ? git(["ls-files"]) : git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]))
  .split("\n")
  .map((f) => f.trim())
  .filter(Boolean);

// 1. Paths that must never be committed.
const BLOCKED_PATHS = [
  { test: (f) => f.startsWith("data/"), why: "real documents live in /data (use /sample-data for demo files)" },
  { test: (f) => f.startsWith("exports/") || /\.export\./.test(f), why: "exports can contain real data" },
  { test: (f) => /(^|\/)\.env($|\.)/.test(f) && !f.endsWith(".env.example"), why: ".env files hold secrets" },
  { test: (f) => f.startsWith("eval/results/"), why: "eval results can quote real documents" },
  {
    // Document-type files are only allowed inside /sample-data (and test fixtures).
    test: (f) =>
      /\.(pdf|csv|xlsx|xls|docx|doc|numbers|pages)$/i.test(f) &&
      !f.startsWith("sample-data/") &&
      !f.startsWith("test/fixtures/"),
    why: "document files belong in /data (private) or /sample-data (fictional)",
  },
];

// 2. Content that looks like a secret or real pricing.
const SECRET_PATTERNS = [
  { re: /sk-ant-[A-Za-z0-9_-]{10,}/, what: "Anthropic API key" },
  { re: /\bpa-[A-Za-z0-9_-]{30,}/, what: "Voyage AI API key" },
  { re: /\bsb_secret_[A-Za-z0-9_-]{10,}/, what: "Supabase secret key" },
  { re: /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{8,}/, what: "Resend API key" },
  { re: /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, what: "JWT (Supabase key?)" },
  { re: /postgres(ql)?:\/\/[^:\s]+:[^@\s]{6,}@/, what: "database URL with password" },
  { re: /\bEVO-[A-Z0-9]{2,5}-[A-Z]{2,4}\b/, what: "real Evolution SKU (sample data should use the fictional RDG- brand)" },
];

// This file necessarily contains the patterns above — skip scanning itself.
const SELF = "scripts/check-staged.mjs";

const problems = [];

for (const f of files) {
  for (const rule of BLOCKED_PATHS) {
    if (rule.test(f)) problems.push(`  ✗ ${f}\n      → ${rule.why}`);
  }
  if (f === SELF) continue;
  let content;
  try {
    content = all ? git(["show", `HEAD:${f}`]) : git(["show", `:${f}`]);
  } catch {
    continue; // binary or unreadable — path rules above still apply
  }
  for (const p of SECRET_PATTERNS) {
    if (p.re.test(content)) problems.push(`  ✗ ${f}\n      → looks like it contains a ${p.what}`);
  }
}

if (problems.length) {
  console.error("\n🛑 Commit blocked — this repo is PUBLIC and these files look private:\n");
  console.error(problems.join("\n"));
  console.error(
    "\nIf a file is genuinely safe (fictional sample data), move it under /sample-data.\n" +
      "Unstage a file with:  git restore --staged <file>\n",
  );
  process.exit(1);
}

if (all) console.log(`✓ ${files.length} tracked files checked — no private data or secrets found.`);
