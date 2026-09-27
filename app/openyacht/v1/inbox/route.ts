// POST /openyacht/v1/inbox — pushes from partners this node subscribed to (API-11).
import { federation } from "@/lib/federation/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) => federation.inbox(request);

const wrongMethod = (request: Request) => federation.methodNotAllowed(request, ["POST"]);

export { wrongMethod as GET, wrongMethod as PUT, wrongMethod as PATCH, wrongMethod as DELETE };
