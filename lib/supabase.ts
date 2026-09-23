// Server-side Supabase client. Uses the SECRET key, which bypasses Row Level
// Security — so this must only ever run on the server (scripts, API routes),
// never in a browser bundle.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config";

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  client ??= createClient(config.supabaseUrl(), config.supabaseSecretKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
