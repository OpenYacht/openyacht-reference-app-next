import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { optionalEnv } from "@/lib/env";

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * The check in front of the internal routes a scheduler calls. With no
 * INTERNAL_API_SECRET configured they refuse to run at all: an unset secret
 * must never mean an open endpoint. Null when the caller may proceed.
 */
export function refuseUnlessInternal(request: Request): Response | null {
  const secret = optionalEnv("INTERNAL_API_SECRET");
  if (secret === undefined) return Response.json({ error: "INTERNAL_API_SECRET is not set." }, { status: 503 });
  const presented = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  return timingSafeEqual(digest(presented), digest(secret)) ? null : new Response(null, { status: 401 });
}
