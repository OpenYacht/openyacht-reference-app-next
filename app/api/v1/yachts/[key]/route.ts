// GET /api/v1/yachts/{key} — one yacht by its x_key.
import { authenticateApiKey } from "@/lib/data-api/auth";
import { findYacht } from "@/lib/data-api/yachts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: RouteContext<"/api/v1/yachts/[key]">) {
  const refused = await authenticateApiKey(request, "yachts:read");
  if (refused) return refused;
  const yacht = await findYacht((await params).key);
  if (yacht === null) return Response.json({ error: "Not found." }, { status: 404, headers: { "cache-control": "no-store" } });
  return Response.json({ data: yacht }, { headers: { "cache-control": "no-store" } });
}
