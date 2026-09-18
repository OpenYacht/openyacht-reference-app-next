// GET /openyacht/v1/listings/{uuid} — the dereference target of a canonical URI (ID-1).
import { federation } from "@/lib/federation/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/openyacht/v1/listings/[uuid]">) {
  return federation.listing(request, (await context.params).uuid);
}

const wrongMethod = (request: Request) => federation.methodNotAllowed(request, ["GET"]);

export { wrongMethod as POST, wrongMethod as PUT, wrongMethod as PATCH, wrongMethod as DELETE };
