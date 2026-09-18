import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabasePublishableKey, supabaseUrl } from "@/lib/env";
import { isSetupComplete } from "@/lib/node/setup-state";

// Runs in front of the admin UI only. Federation routes are excluded by the
// matcher: they authenticate by request signature, guard their own host, and
// answer 503 by themselves until setup completes.
//
// This is routing, not authorisation. Every page and Server Action checks the
// caller again, because a matcher change can silently remove proxy coverage.
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const redirectTo = (path: string) => NextResponse.redirect(new URL(path, request.url));

  // Until setup completes, every route leads to the wizard. A database that
  // cannot be reached or an unset variable lands there too: /setup is the
  // page that explains what is missing.
  const setupComplete = await isSetupComplete().catch(() => false);
  if (!setupComplete) return pathname === "/setup" ? NextResponse.next() : redirectTo("/setup");
  if (pathname === "/setup") return redirectTo("/");

  // Refresh the Supabase session so Server Components read a current token.
  let response = NextResponse.next({ request });
  const supabase = createServerClient(supabaseUrl(), supabasePublishableKey(), {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        for (const [key, value] of Object.entries(headers ?? {})) response.headers.set(key, value);
      },
    },
  });
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims);

  if (!signedIn && pathname !== "/login") return redirectTo("/login");
  if (signedIn && pathname === "/login") return redirectTo("/");
  return response;
}

export const config = {
  matcher: ["/((?!\\.well-known/|openyacht/|_next/static|_next/image|favicon\\.ico).*)"],
};
