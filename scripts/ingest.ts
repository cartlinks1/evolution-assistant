// ════════════════════════════════════════════════════════════════════
// INGEST — read the data folder, chunk, embed, and store in Supabase.
//
//   npm run ingest              → ingest DATA_DIR (default: ./data)
//   npm run ingest -- --sample  → ingest ./sample-data (fictional demo brand)
//   npm run ingest -- --force   → re-embed everything, even unchanged files
//
// The database mirrors the folder: new files are added, changed files are
// replaced, and files you deleted (or marked exclude) are removed.
// ════════════════════════════════════════════════════════════════════

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { withContext, wordCount } from "../lib/chunking";
import { config } from "../lib/config";
import { SUPPORTED_EXTENSIONS, loadFile } from "../lib/loaders";
import { normalizePath, readManifest, titleFromFilename } from "../lib/manifest";
import { MONEY_PATTERN } from "../lib/pricing";
import { db } from "../lib/supabase";
import type { Audience, DocumentMeta } from "../lib/types";
import { embed } from "../lib/voyage";

const args = process.argv.slice(2);
const dataDir = path.resolve(args.includes("--sample") ? "sample-data" : config.dataDir);
const force = args.includes("--force");

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

/** Words that suggest a file might be dealer-only. Only a warning — the folder decides. */
const DEALER_HINTS = /dealer|wholesale|price\s*tier|pricing\s*tier|net\s*price|msrp\s*vs|margin|distributor/i;

async function main() {
  console.log(`\nIngesting from ${path.relative(process.cwd(), dataDir) || "."}/\n`);
  const manifest = await readManifest(dataDir);
  const store = db();

  const files = (await walk(dataDir)).filter((f) => {
    const rel = path.relative(dataDir, f).toLowerCase();
    return rel !== "manifest.csv" && rel !== "readme.md";
  });
  // Extra safety net for files that must never be ingested, whatever they're named or wherever
  // they're dropped: INGEST_BLOCKLIST=differentiators,old-price-list  (substring match, case-insensitive)
  const blocklist = (process.env.INGEST_BLOCKLIST ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const plan: { abs: string; meta: DocumentMeta }[] = [];
  const skipped: string[] = [];

  for (const abs of files) {
    const rel = path.relative(dataDir, abs).split(path.sep).join("/");
    const ext = path.extname(abs).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
      skipped.push(`${rel} — unsupported file type (${ext || "none"})`);
      continue;
    }
    const top = rel.split("/")[0];
    if (top !== "public" && top !== "dealer") {
      skipped.push(`${rel} — must be inside public/ or dealer/ (that's how audience is decided)`);
      continue;
    }
    const blocked = blocklist.find((b) => rel.toLowerCase().includes(b));
    if (blocked) {
      skipped.push(`${rel} — matches INGEST_BLOCKLIST ("${blocked}")`);
      continue;
    }
    const entry = manifest.get(normalizePath(rel));
    if (entry?.exclude) {
      skipped.push(`${rel} — excluded in manifest.csv`);
      continue;
    }
    if (!entry) console.warn(`⚠  ${rel} is not in manifest.csv — using defaults (approved_for_claims = false).`);

    const mtime = (await stat(abs)).mtime.toISOString().slice(0, 10);
    plan.push({
      abs,
      meta: {
        path: rel,
        title: entry?.title ?? titleFromFilename(rel),
        audience: top as Audience,
        approvedForClaims: entry?.approvedForClaims ?? false,
        lastUpdated: entry?.lastUpdated ?? mtime,
      },
    });
  }

  // What's already in the database?
  const { data: existing, error: exErr } = await store.from("documents").select("id, path, content_hash");
  if (exErr) throw new Error(`Could not read documents table (did you run npm run db:migrate?): ${exErr.message}`);
  const existingByPath = new Map((existing ?? []).map((d) => [d.path as string, d as { id: string; content_hash: string }]));

  const summary: Record<string, string | number>[] = [];
  let embedTokens = 0;

  const failures: string[] = [];
  for (const { abs, meta } of plan) {
    try {
      const bytes = await readFile(abs);
      // The hash covers the file AND its tags, so changing a manifest flag also triggers a re-ingest.
      const hash = createHash("sha256").update(bytes).update(JSON.stringify(meta)).digest("hex");
      const prior = existingByPath.get(meta.path);
      existingByPath.delete(meta.path);

      if (prior && prior.content_hash === hash && !force) {
        summary.push({ file: meta.path, audience: meta.audience, approved: meta.approvedForClaims ? "yes" : "no", status: "unchanged" });
        continue;
      }

      const loaded = await loadFile(abs);
      for (const w of loaded.warnings) console.warn(`⚠  ${meta.path}: ${w}`);
      if (meta.audience === "public") {
        const text = loaded.chunks.map((c) => c.content).join(" ") + " " + meta.path;
        if (DEALER_HINTS.test(text)) {
          console.warn(`⚠  ${meta.path} is in public/ but mentions dealer/wholesale pricing terms. Double-check it belongs there.`);
        }
      }

      // Dealer pricing is never served by the assistant (it's handled by email). The answer-time
      // guards would strip it anyway, but it's safest if prices aren't in the index at all.
      const priced = loaded.chunks.filter((c) => MONEY_PATTERN.test(c.content));
      if (priced.length && (meta.audience === "dealer" || DEALER_HINTS.test(meta.path))) {
        console.warn(
          `⚠  ${meta.path} contains prices in ${priced.length} section(s): ${[...new Set(priced.map((c) => c.section ?? "(intro)"))].join("; ")}.\n` +
            `   The assistant will never state dealer pricing, but please remove prices from this document if you can.`,
        );
      }

      // 1. Embed first — if this fails, the old version stays in place untouched.
      const texts = loaded.chunks.map((c) => withContext(meta.title, c.section, c.content));
      const { vectors, tokens } = texts.length ? await embed(texts, "document") : { vectors: [], tokens: 0 };
      embedTokens += tokens;

      // 2. Replace the old version (chunks + fitment rows cascade-delete with the document).
      if (prior) await store.from("documents").delete().eq("id", prior.id);

      const { data: doc, error: docErr } = await store
        .from("documents")
        .insert({
          path: meta.path,
          title: meta.title,
          audience: meta.audience,
          approved_for_claims: meta.approvedForClaims,
          last_updated: meta.lastUpdated,
          content_hash: hash,
        })
        .select("id")
        .single();
      if (docErr || !doc) throw new Error(`Insert document ${meta.path} failed: ${docErr?.message}`);

      try {
        const chunkRows = loaded.chunks.map((c, i) => ({
          document_id: doc.id,
          chunk_index: i,
          section: c.section,
          content: c.content,
          audience: meta.audience,
          embedding: vectors[i],
        }));
        for (let i = 0; i < chunkRows.length; i += 100) {
          const { error } = await store.from("chunks").insert(chunkRows.slice(i, i + 100));
          if (error) throw new Error(error.message);
        }
        if (loaded.fitment?.length) {
          const { error } = await store.from("fitment").insert(
            loaded.fitment.map((r) => ({
              document_id: doc.id,
              row_number: r.rowNumber,
              make: r.make,
              model: r.model,
              year_start: r.yearStart,
              year_end: r.yearEnd,
              year_label: r.yearLabel,
              sku: r.sku,
              notes: r.notes,
              audience: meta.audience,
            })),
          );
          if (error) throw new Error(error.message);
        }
      } catch (e) {
        // Don't leave a half-ingested document behind.
        await store.from("documents").delete().eq("id", doc.id);
        throw new Error(`Storing ${meta.path} failed: ${(e as Error).message}`);
      }

      const words = loaded.chunks.reduce((n, c) => n + wordCount(c.content), 0);
      summary.push({
        file: meta.path,
        audience: meta.audience,
        approved: meta.approvedForClaims ? "yes" : "no",
        status: prior ? "updated" : "added",
        chunks: loaded.chunks.length,
        "avg words": loaded.chunks.length ? Math.round(words / loaded.chunks.length) : 0,
        "fitment rows": loaded.fitment?.length ?? "",
      });
    } catch (e) {
      // One bad file shouldn't stop the rest. Its previous version (if any) is left untouched.
      failures.push(`${meta.path} — ${(e as Error).message}`);
      summary.push({ file: meta.path, status: "FAILED" });
    }
  }

  // Anything left in the database that's no longer in the folder (or is now excluded) gets removed.
  for (const [p, d] of existingByPath) {
    await store.from("documents").delete().eq("id", d.id);
    summary.push({ file: p, status: "removed" });
  }

  console.table(summary);
  if (skipped.length) console.log(`\nSkipped:\n  ${skipped.join("\n  ")}`);
  console.log(`\nEmbedding tokens used: ${embedTokens.toLocaleString()}\n`);
  if (failures.length) {
    console.error(`✗ ${failures.length} file(s) failed:\n  ${failures.join("\n  ")}\n`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`\n✗ ${(e as Error).message}\n`);
  process.exit(1);
});
