import "server-only";
import { createHash } from "node:crypto";
import { serviceClient } from "@/lib/supabase/service";

// Authentication for the data API. A key is presented in the X-API-Key header
// or as a Bearer token — never in the query string, which lands in access
// logs, proxy logs and browser history. Keys are compared by SHA-256 digest;
// the plaintext is never stored.
//
// There is deliberately no per-key allowlist of browser origins. Origin and
// Referer are set by the client, so a check on them constrains well-behaved
// browsers and nothing else. A key is a server-side credential: keep it on
// the server that renders the site.

export const hashApiKey = (plaintext: string) => createHash("sha256").update(plaintext).digest("hex");

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

/** Null when the request may proceed; otherwise the response to send. */
export async function authenticateApiKey(request: Request, scope: string): Promise<Response | null> {
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const presented = request.headers.get("x-api-key") ?? bearer ?? "";
  if (presented === "") return json(401, { error: "An API key is required, in the X-API-Key header or as a Bearer token." });

  const { data, error } = await serviceClient().rpc("use_api_key", { p_key_hash: hashApiKey(presented) });
  if (error) throw new Error(`Cannot check the API key: ${error.message}`);
  const key = (data as { key_id: number; scopes: string[]; retry_after: number }[])[0];
  if (key === undefined) return json(401, { error: "Invalid or revoked API key." });
  if (!key.scopes.includes(scope)) return json(403, { error: `The API key does not have the ${scope} scope.` });
  if (key.retry_after > 0) {
    return json(429, { error: "Rate limit exceeded.", retry_after: key.retry_after }, { "retry-after": String(key.retry_after) });
  }
  return null;
}
