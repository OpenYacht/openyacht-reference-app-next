import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseSecretKey, supabaseUrl } from "@/lib/env";

let client: SupabaseClient | undefined;

/**
 * The service-role client: bypasses row level security. Used by federation
 * route handlers and first-run setup only — code that authenticates its
 * caller some other way (a request signature, the setup token). Never import
 * this into anything that renders for a signed-in user; that code uses
 * lib/supabase/server.ts and lives under RLS.
 */
export function serviceClient(): SupabaseClient {
  client ??= createClient(supabaseUrl(), supabaseSecretKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
