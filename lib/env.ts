import "server-only";

// Environment access with one rule: a variable that is present but blank is
// treated exactly like one that is missing. `process.env.X ?? fallback` does
// not do that — it lets "" through — which is how a half-filled .env file ends
// up configuring an application with empty strings.

export class MissingEnvError extends Error {}

/** First non-blank value among `names`, or undefined. */
export function optionalEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function requireEnv(...names: string[]): string {
  const value = optionalEnv(...names);
  if (value === undefined) throw new MissingEnvError(`${names.join(" or ")} is not set.`);
  return value;
}

// Supabase renamed its API keys (publishable / secret, formerly anon /
// service_role). Both spellings are accepted so the app works with a project
// of either generation and with what hosting integrations inject.
export const supabaseUrl = () => requireEnv("NEXT_PUBLIC_SUPABASE_URL");
export const supabasePublishableKey = () => requireEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY");
export const supabaseSecretKey = () => requireEnv("SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY");
