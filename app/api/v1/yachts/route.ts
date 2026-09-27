// GET /api/v1/yachts — every yacht this node displays, for its own websites
// and feeds. API key with the yachts:read scope. ?source=own|imported narrows
// it; page and per_page (at most 200) page it; links.next walks it.
import { authenticateApiKey } from "@/lib/data-api/auth";
import { listYachts, type Source } from "@/lib/data-api/yachts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const refused = await authenticateApiKey(request, "yachts:read");
  if (refused) return refused;

  const url = new URL(request.url);
  const source: Source = url.searchParams.get("source") === "own" ? "own" : url.searchParams.get("source") === "imported" ? "imported" : "all";
  const perPage = Math.min(Math.max(Number.parseInt(url.searchParams.get("per_page") ?? "25", 10) || 25, 1), 200);
  const page = Math.max(Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1, 1);

  const items = await listYachts(source);
  const lastPage = Math.max(Math.ceil(items.length / perPage), 1);
  const next = new URL(url);
  next.searchParams.set("page", String(page + 1));
  return Response.json(
    {
      data: items.slice((page - 1) * perPage, page * perPage),
      links: { next: page < lastPage ? next.toString() : null },
      meta: { current_page: page, last_page: lastPage, per_page: perPage, total: items.length },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
