// GET /api/health — is the live site configured correctly? (yes/no only, never values)
//
//   settings   which required settings are present
//   checks     whether the Anthropic key and the database actually work — both checks
//              are free (a model lookup and a row count), so this is safe to leave public
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { config, readSetting } from "@/lib/config";
import { db } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REQUIRED = ["ANTHROPIC_API_KEY", "VOYAGE_API_KEY", "SUPABASE_URL", "SUPABASE_SECRET_KEY", "CONTACT_EMAIL", "CONTACT_PHONE"];

async function check(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "ok";
  } catch (e) {
    // Report the kind of failure only — never echo settings.
    const msg = (e as Error).message ?? "";
    return /401|invalid|authentication/i.test(msg) ? "invalid key" : "failed";
  }
}

/** Length + 8-char hash of a key: enough to compare with a local copy, impossible to reverse. */
const fingerprint = (v: string | undefined) =>
  v ? `${v.length} chars, ${createHash("sha256").update(v).digest("hex").slice(0, 8)}` : "missing";

export async function GET() {
  const settings = Object.fromEntries(REQUIRED.map((k) => [k, Boolean(readSetting(k))]));
  const fingerprints = {
    ANTHROPIC_API_KEY: fingerprint(readSetting("ANTHROPIC_API_KEY")),
    VOYAGE_API_KEY: fingerprint(readSetting("VOYAGE_API_KEY")),
  };
  const checks = {
    anthropic: await check(() => new Anthropic({ apiKey: config.anthropicApiKey() }).models.retrieve(config.claudeModel)),
    database: await check(async () => {
      const { error } = await db().from("documents").select("id", { head: true, count: "exact" });
      if (error) throw new Error(error.message);
    }),
  };
  const ok = Object.values(settings).every(Boolean) && Object.values(checks).every((c) => c === "ok");
  return Response.json({ ok, settings, checks, fingerprints });
}
