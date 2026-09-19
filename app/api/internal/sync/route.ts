// POST /api/internal/sync — one sync pass over every partner that is due.
//
// Next.js has no scheduler, so something outside calls this on a timer:
// pg_cron with pg_net from the database, a host's cron feature, or plain
// crontab with curl. `pnpm sync` calls it by hand. It is protected by
// INTERNAL_API_SECRET; with no secret configured it refuses to run at all —
// an unset secret must never mean an open endpoint.
import { createHash, timingSafeEqual } from "node:crypto";
import { optionalEnv } from "@/lib/env";
import { syncDuePartners } from "@/lib/federation/consumer";
import { isSetupComplete } from "@/lib/node/setup-state";
import { serviceClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A cold sync of a large partner takes a while.
export const maxDuration = 300;

const digest = (value: string) => createHash("sha256").update(value).digest();

export async function POST(request: Request) {
  const secret = optionalEnv("INTERNAL_API_SECRET");
  if (secret === undefined) return Response.json({ error: "INTERNAL_API_SECRET is not set." }, { status: 503 });

  const presented = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!timingSafeEqual(digest(presented), digest(secret))) return new Response(null, { status: 401 });
  if (!(await isSetupComplete())) return Response.json({ error: "Setup has not been completed." }, { status: 503 });

  // The timer that drives syncing also ends key-rotation overlaps that have run
  // out. Publication never waits for this — it is decided by time — but the
  // revoked key's seed is destroyed here.
  const { error } = await serviceClient().rpc("expire_retiring_keys");
  if (error) console.error(`[openyacht] cannot expire retiring keys: ${error.message}`);

  const force = new URL(request.url).searchParams.get("force") === "1";
  return Response.json({ results: await syncDuePartners({ force }) });
}
