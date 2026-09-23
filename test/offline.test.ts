// Tests for everything that runs without API keys: chunking, fitment parsing,
// the claims guard, manifest rules, and the file loaders on the sample data.
// Run with: npm test

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chunkMarkdown, packParagraphs, wordCount } from "../lib/chunking";
import { guardClaims } from "../lib/claims";
import { isFitmentCsv, parseYearRange, yearInRange } from "../lib/fitment";
import { loadFile } from "../lib/loaders";
import { readManifest } from "../lib/manifest";
import { guardDealerPricing } from "../lib/dealer";
import { toKeywordQuery } from "../lib/retrieval";

const sample = (p: string) => path.resolve("sample-data", p);

test("markdown is split on headings and keeps the heading path", () => {
  const chunks = chunkMarkdown("# Guide\n\nIntro text.\n\n## Step 1\n\nDo the thing.\n\n### Detail\n\nMore.");
  assert.deepEqual(
    chunks.map((c) => c.section),
    ["Guide", "Guide › Step 1", "Guide › Step 1 › Detail"],
  );
});

test("long sections are packed under the max size, with overlap", () => {
  const para = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ") + ".";
  const chunks = packParagraphs([para, para, para, para, para], "S", { target: 300, max: 400, overlap: 20 });
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(wordCount(c.content) <= 400 + 20, `chunk too big: ${wordCount(c.content)}`);
  assert.ok(chunks[1]!.content.startsWith("…"), "second chunk should start with the overlap");
});

test("year ranges parse into numbers", () => {
  assert.deepEqual(parseYearRange("2004–2023"), { start: 2004, end: 2023 });
  assert.deepEqual(parseYearRange("2004-2023"), { start: 2004, end: 2023 });
  assert.deepEqual(parseYearRange("2017–Present"), { start: 2017, end: null });
  assert.deepEqual(parseYearRange("2021+"), { start: 2021, end: null });
  assert.deepEqual(parseYearRange("2019"), { start: 2019, end: 2019 });
  assert.deepEqual(parseYearRange("Up to 2015"), { start: null, end: 2015 });
  assert.deepEqual(parseYearRange("04-23"), { start: 2004, end: 2023 });
  assert.deepEqual(parseYearRange(""), { start: null, end: null });
});

test("a year inside a range matches; outside does not", () => {
  assert.equal(yearInRange(2019, 2004, 2023), true);
  assert.equal(yearInRange(2024, 2004, 2023), false);
  assert.equal(yearInRange(2003, 2004, 2023), false);
  assert.equal(yearInRange(2030, 2017, null), true);
  assert.equal(yearInRange(null, 2004, 2023), true);
});

test("fitment CSV is detected and parsed into structured rows", async () => {
  const loaded = await loadFile(sample("fitment.csv"));
  assert.ok(loaded.fitment);
  assert.equal(loaded.fitment.length, 6);
  const onward = loaded.fitment.find((r) => r.model === "Onward")!;
  assert.equal(onward.sku, "RDG-CCO-CLR");
  assert.equal(onward.yearStart, 2017);
  assert.equal(onward.yearEnd, null);
  assert.equal(loaded.chunks.length, 1, "one overview chunk for broad search");
  assert.equal(isFitmentCsv(["Name", "Price"]), false);
});

test("PDF text is extracted page by page", async () => {
  const loaded = await loadFile(sample("install-guide.pdf"));
  assert.equal(loaded.warnings.length, 0, loaded.warnings.join("; "));
  const all = loaded.chunks.map((c) => c.content).join(" ");
  assert.match(all, /8 ft-lb/);
  assert.equal(loaded.chunks[0]!.section, "Page 1");
});

test("manifest: flags default safe, exclusions honored", async () => {
  const m = await readManifest(path.resolve("sample-data"));
  assert.equal(m.get("product-specs.md")?.approvedForClaims, true);
  assert.equal(m.get("brochure.md")?.approvedForClaims, false);
  assert.equal(m.get("old-differentiators.md")?.exclude, true);
});

test("keyword query ORs the words together and splits SKUs", () => {
  assert.equal(toKeywordQuery("Does RDG-CCO-CLR fit?"), "does | rdg | cco | clr | fit");
});

test("claims guard: approved + matching numbers passes", () => {
  const r = guardClaims([
    {
      text: "It blocks 99% of UVA and UVB light, per ASTM E903 testing by Northfield Test Labs.",
      citations: [{ citedText: "Blocks 99% of UVA and UVB light, per ASTM E903 testing by Northfield Test Labs (report NTL-2304).", approvedForClaims: true }],
    },
  ]);
  assert.equal(r.removed.length, 0);
});

test("claims guard: claim from a non-approved document is removed", () => {
  const r = guardClaims([
    {
      text: "They're 250 times stronger than glass. Riders love them.",
      citations: [{ citedText: "virtually unbreakable and 250 times stronger than glass", approvedForClaims: false }],
    },
  ]);
  assert.equal(r.removed.length, 1);
  assert.equal(r.segments[0]!.text.trim(), "Riders love them.");
});

test("claims guard: a changed number is caught", () => {
  const r = guardClaims([
    { text: "It blocks 100% of UV light.", citations: [{ citedText: "Blocks 99% of UVA and UVB light", approvedForClaims: true }] },
  ]);
  assert.equal(r.removed.length, 1);
  assert.match(r.removed[0]!.reason, /100/);
});

test("claims guard: an uncited claim is removed", () => {
  const r = guardClaims([{ text: "It's DOT approved.", citations: [] }]);
  assert.equal(r.removed.length, 1);
});

test("claims guard: an uncited lead-in is judged with the cited rest of its sentence", () => {
  // Real case from the first live run: Claude split one sentence across two segments.
  const r = guardClaims([
    { text: "On UV, yes: ", citations: [] },
    {
      text: "the Trail Series blocks 99% of UVA and UVB light, per ASTM E903 testing.",
      citations: [{ citedText: "Blocks 99% of UVA and UVB light, per ASTM E903 testing by Northfield Test Labs", approvedForClaims: true }],
    },
  ]);
  assert.equal(r.removed.length, 0);
  assert.equal(r.segments.map((s) => s.text).join(""), "On UV, yes: the Trail Series blocks 99% of UVA and UVB light, per ASTM E903 testing.");
});

test("claims guard: declining to make a claim is not a claim", () => {
  const r = guardClaims([
    { text: "For a strength comparison against glass, I don't have an approved figure I can quote.", citations: [] },
  ]);
  assert.equal(r.removed.length, 0);
});

test("claims guard: 'Z26.1' doesn't split a sentence", () => {
  const r = guardClaims([
    { text: "It's certified under ANSI/SAE Z26.1-1996.", citations: [{ citedText: "certified AS-4 under ANSI/SAE Z26.1-1996", approvedForClaims: true }] },
  ]);
  assert.equal(r.removed.length, 0);
});

test("claims guard: pricing percentages are not treated as claims", () => {
  const r = guardClaims([{ text: "A 15% restocking fee applies.", citations: [] }]);
  assert.equal(r.removed.length, 0);
});

test("dealer guard: a dealer price is removed, the rest kept", () => {
  const r = guardDealerPricing([
    {
      text: "Silver dealers pay $199 per clear panel. Orders ship by freight.",
      citations: [{ citedText: "| Silver | 25–99 | $199 | $229 |", approvedForClaims: false }],
    },
  ]);
  assert.equal(r.removed.length, 1);
  assert.equal(r.segments[0]!.text.trim(), "Orders ship by freight.");
});

test("dealer guard: wholesale pricing without a citation is removed", () => {
  const r = guardDealerPricing([{ text: "Wholesale price is $179.", citations: [] }]);
  assert.equal(r.removed.length, 1);
});

test("dealer guard: retail prices are kept", () => {
  const r = guardDealerPricing([
    {
      text: "Expedited 2-day shipping is available for $49.",
      citations: [{ citedText: "Expedited 2-day shipping is available for $49.", approvedForClaims: false }],
    },
  ]);
  assert.equal(r.removed.length, 0);
});
