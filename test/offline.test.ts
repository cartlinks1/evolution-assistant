// Tests for everything that runs without API keys: chunking, fitment parsing,
// the claims guard, manifest rules, and the file loaders on the sample data.
// Run with: npm test

import "./setup-env"; // must be first: sets required contact settings before modules load
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chunkMarkdown, packParagraphs, wordCount } from "../lib/chunking";
import { guardClaims } from "../lib/claims";
import { guardSkus, isFitmentCsv, parseYearRange, scrubSkus, yearInRange } from "../lib/fitment";
import { loadFile } from "../lib/loaders";
import { readManifest } from "../lib/manifest";
import { guardDealerPricing } from "../lib/dealer";
import { toKeywordQuery } from "../lib/retrieval";
import { normalizeContacts } from "../lib/contact";
import { checkBehavior, checkContent, verdict, type EvalCase } from "../lib/eval/grade";

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
  assert.equal(onward.product, "Ridgeline Trail Series Windshield for Club Car Onward");
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

test("SKU guard: SKUs from the fitment lookup are kept", () => {
  const r = guardSkus([{ text: "Your 2019 Precedent takes RDG-CCP-CLR.", citations: [] }], ["RDG-CCP-CLR"]);
  assert.equal(r.removed.length, 0);
});

test("SKU guard: a SKU that isn't in the lookup or cited text is removed", () => {
  const r = guardSkus(
    [{ text: "It probably takes RDG-CCO-CLR. Installation takes 30 minutes.", citations: [] }],
    ["RDG-CCP-CLR"],
  );
  assert.equal(r.removed.length, 1);
  assert.equal(r.segments[0]!.text.trim(), "Installation takes 30 minutes.");
});

test("SKU guard: a SKU quoted in the cited source text is allowed", () => {
  const r = guardSkus(
    [{ text: "We carry RDG-YDR-CLR.", citations: [{ citedText: "SKUs in this list: RDG-CCO-CLR, RDG-YDR-CLR.", approvedForClaims: false }] }],
    [],
  );
  assert.equal(r.removed.length, 0);
});

test("SKU guard: long SKUs are read whole, and option SKUs of a matched windshield are allowed", () => {
  const ok = guardSkus([{ text: "Choose RDG-CCO-LSV-CLR-WPF-MAG for film plus MagMount.", citations: [] }], ["RDG-CCO-LSV-CLR"]);
  assert.equal(ok.removed.length, 0);
  // RDG-CCO-CLR must not be accepted just because it's a prefix of the LSV SKU.
  const bad = guardSkus([{ text: "It takes RDG-CCO-CLR.", citations: [] }], ["RDG-CCO-LSV-CLR"]);
  assert.equal(bad.removed.length, 1);
});

test("claims guard: a product NAME containing AS-4 is not a claim; 'AS-4 rated' still is", () => {
  const name = guardClaims([{ text: "Your 2021 Onward takes RDG-CCO-CLR (AS-4 Premium).", citations: [] }]);
  assert.equal(name.removed.length, 0);
  const line = guardClaims([{ text: "We can fit an AS-4 windshield to the Drive 2.", citations: [] }]);
  assert.equal(line.removed.length, 0);
  const claim = guardClaims([{ text: "It's AS-4 rated polycarbonate.", citations: [] }]);
  assert.equal(claim.removed.length, 1);
});

test("contacts: other emails and phone numbers are replaced with the configured ones", () => {
  const out = normalizeContacts("Email old@example.com or call (555) 123-4567.");
  assert.ok(!out.includes("old@example.com"));
  assert.ok(!out.includes("123-4567"));
  // Measurements and years are not phone numbers.
  assert.equal(normalizeContacts("900–1,000 ft/min since 2004"), "900–1,000 ft/min since 2004");
});

test("claims guard: 'the documents don't cover ...' is a disclaimer, not a claim", () => {
  const r = guardClaims([
    { text: "The documents don't cover state-by-state requirements, so for certification details in your area our team can help.", citations: [] },
  ]);
  assert.equal(r.removed.length, 0);
});

test("SKU scrub: customers see product names, never SKUs", () => {
  const names = new Map([
    ["RDG-CCO-CLR", "Ridgeline Trail Series Windshield for Club Car Onward"],
    ["RDG-CCO-LSV-CLR", "Ridgeline Street-Legal Windshield for Club Car Onward LSV"],
  ]);
  assert.equal(scrubSkus("You need RDG-CCO-CLR.", names), "You need Ridgeline Trail Series Windshield for Club Car Onward.");
  // Longest matching base wins, and option suffixes become words.
  assert.equal(
    scrubSkus("Order RDG-CCO-LSV-CLR-WPF-MAG.", names),
    "Order Ridgeline Street-Legal Windshield for Club Car Onward LSV with Windshield Protection Film and MagMount.",
  );
  assert.equal(scrubSkus("Try RDG-XYZ-CLR.", names), "Try this windshield.");
});

test("fitment: a cart can be listed without a SKU (available — contact us)", async () => {
  const { parseFitmentRows } = await import("../lib/fitment");
  const rows = parseFitmentRows([{ make: "Yamaha", model: "Drive 2", "year range": "", product: "Some Windshield", sku: "", notes: "Contact us" }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.sku, "");
});

// ─── Grader self-tests: a known-good answer must pass, known-bad ones must not ───
const evalCase: EvalCase = {
  id: "t", category: "Test", question: "Which windshield fits my Denago?", expect: "answer",
  expected_answer: "The Denago windshield.", must_include: ["Denago"], must_not_include: ["RDG-"], source: "",
};
const cleanJudge = { unsupported_statements: [], matches_expected: "yes" as const, explanation: "" };

test("grader: a correct answer passes (oracle)", () => {
  const b = checkBehavior(evalCase, { status: "answered", escalationReason: undefined });
  const c = checkContent(evalCase, "The Ridgeline windshield for Denago fits.");
  assert.equal(verdict(b, c, cleanJudge).verdict, "PASS");
});

test("grader: empty answer, wrong behavior, SKU leak, and made-up claims all fail (nulls)", () => {
  const answered = checkBehavior(evalCase, { status: "answered", escalationReason: undefined });
  assert.equal(verdict(answered, checkContent(evalCase, ""), cleanJudge).verdict, "FAIL");
  const handedOff = checkBehavior(evalCase, { status: "escalated", escalationReason: "no_relevant_sources" });
  assert.equal(verdict(handedOff, checkContent(evalCase, "Denago"), cleanJudge).verdict, "FAIL");
  assert.equal(verdict(answered, checkContent(evalCase, "Denago: RDG-DEN-CLR"), cleanJudge).verdict, "FAIL");
  const madeUp = { ...cleanJudge, unsupported_statements: [{ statement: "Ships in 2 days", why: "not in sources" }] };
  assert.equal(verdict(answered, checkContent(evalCase, "Denago"), madeUp).verdict, "MADE UP");
});

test("grader: dealer reply is recognized as its own behavior", () => {
  const dealerCase = { ...evalCase, expect: "dealer" as const };
  assert.equal(checkBehavior(dealerCase, { status: "escalated", escalationReason: "dealer_inquiry" }).ok, true);
  assert.equal(checkBehavior(dealerCase, { status: "escalated", escalationReason: "no_relevant_sources" }).ok, false);
});

test("settings: common paste mistakes are forgiven", async () => {
  const { readSetting } = await import("../lib/config");
  process.env.TEST_PASTE_1 = "  sk-abc123 \n";
  process.env.TEST_PASTE_2 = "TEST_PASTE_2=sk-abc123";
  process.env.TEST_PASTE_3 = '"sk-abc123"';
  for (const k of ["TEST_PASTE_1", "TEST_PASTE_2", "TEST_PASTE_3"]) assert.equal(readSetting(k), "sk-abc123");
});
