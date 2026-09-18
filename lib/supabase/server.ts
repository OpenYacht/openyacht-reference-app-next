import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabasePublishableKey, supabaseUrl } from "@/lib/env";

/**
 * The signed-in user's client: every query runs under row level security as
 * that user. One per request — it is bound to the request's cookies.
 */
export async function userClient() {
  const cookieStore = await cookies();
  return createServerClient(supabaseUrl(), supabasePublishableKey(), {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Server Components cannot set cookies. proxy.ts refreshes the
          // session on every request, so nothing is lost here.
        }
      },
    },
  });
}

/** The verified identity of the caller, or null. Uses getClaims(), which checks the JWT's signature. */
export async function currentUserId(): Promise<string | null> {
  const supabase = await userClient();
  const { data } = await supabase.auth.getClaims();
  return data?.claims.sub ?? null;
}
