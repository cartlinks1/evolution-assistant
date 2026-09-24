// GET /api/health — which required settings the live site can see (yes/no only, never values).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REQUIRED = ["ANTHROPIC_API_KEY", "VOYAGE_API_KEY", "SUPABASE_URL", "SUPABASE_SECRET_KEY", "CONTACT_EMAIL", "CONTACT_PHONE"];

export function GET() {
  const settings = Object.fromEntries(REQUIRED.map((k) => [k, Boolean(process.env[k])]));
  return Response.json({ ok: Object.values(settings).every(Boolean), settings });
}
