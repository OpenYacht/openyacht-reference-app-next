// POST /api/internal/push — one run of the push delivery worker (API-10).
// Called by pg_cron every minute while pushes are on and a delivery is due.
// Protected by INTERNAL_API_SECRET, like the sync route.
import { deliverDuePushes } from "@/lib/federation/push";
import { refuseUnlessInternal } from "@/lib/internal-auth";
import { isSetupComplete } from "@/lib/node/setup-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const refused = refuseUnlessInternal(request);
  if (refused) return refused;
  if (!(await isSetupComplete())) return Response.json({ error: "Setup has not been completed." }, { status: 503 });
  return Response.json({ deliveries: await deliverDuePushes() });
}
