// GET /openyacht/v1/listings — the partner feed: cold sync and updated_since polling (API-2, API-3).
import { federation } from "@/lib/federation/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) => federation.listings(request);

const wrongMethod = (request: Request) => federation.methodNotAllowed(request, ["GET"]);

export { wrongMethod as POST, wrongMethod as PUT, wrongMethod as PATCH, wrongMethod as DELETE };
