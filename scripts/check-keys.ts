// Checks each key in .env.local with a free "are you valid?" request.
// Never prints the keys themselves.  Usage: npm run check:keys

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { config } from "../lib/config";

const ok = (name: string, msg: string) => console.log(`  ✓ ${name.padEnd(10)} ${msg}`);
const bad = (name: string, msg: string) => console.log(`  ✗ ${name.padEnd(10)} ${msg}`);
const skip = (name: string, vars: string) => console.log(`  – ${name.padEnd(10)} not filled in yet (${vars})`);

async function checkAnthropic() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return skip("Anthropic", "ANTHROPIC_API_KEY");
  try {
    const m = await new Anthropic({ apiKey: key }).models.retrieve(config.claudeModel);
    ok("Anthropic", `key accepted — ${m.id} available`);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) bad("Anthropic", "key rejected — not valid, expired, or deleted");
    else if (e instanceof Anthropic.NotFoundError) bad("Anthropic", `key accepted, but ${config.claudeModel} isn't available to this account`);
    else bad("Anthropic", (e as Error).message);
  }
}

async function checkVoyage() {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) return skip("Voyage", "VOYAGE_API_KEY");
  // Embedding one word costs a fraction of a cent (and comes out of the free allowance).
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: ["test"], model: config.embeddingModel }),
  });
  if (res.ok) ok("Voyage", `key accepted — ${config.embeddingModel} working`);
  else if (res.status === 401) bad("Voyage", "key rejected — not valid or deleted");
  else bad("Voyage", `error ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function checkSupabaseApi() {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!process.env.SUPABASE_URL || !key) return skip("Supabase", "SUPABASE_URL, SUPABASE_SECRET_KEY");
  try {
    const { error } = await createClient(config.supabaseUrl(), key, { auth: { persistSession: false } })
      .from("documents")
      .select("id", { head: true, count: "exact" });
    // "relation does not exist" just means migrations haven't run yet — the key itself worked.
    if (!error || /does not exist|schema cache/i.test(error.message)) ok("Supabase", "URL + secret key accepted");
    else bad("Supabase", error.message);
  } catch (e) {
    bad("Supabase", `couldn't reach the project — check SUPABASE_URL (${(e as Error).message})`);
  }
}

async function checkDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) return skip("Database", "DATABASE_URL");
  if (url.includes("[YOUR-PASSWORD]")) return bad("Database", "replace [YOUR-PASSWORD] with your database password");
  const sql = postgres(url, { ssl: "require", max: 1, connect_timeout: 10 });
  try {
    await sql`select 1`;
    ok("Database", "connection works");
  } catch (e) {
    bad("Database", (e as Error).message);
  } finally {
    await sql.end();
  }
}

console.log("\nChecking keys in .env.local …\n");
await checkAnthropic();
await checkVoyage();
await checkSupabaseApi();
await checkDatabase();
console.log();
