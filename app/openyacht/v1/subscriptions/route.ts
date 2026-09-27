// POST and DELETE /openyacht/v1/subscriptions — push registration (API-10).
// Served only while this node advertises push subscriptions.
import { federation } from "@/lib/federation/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) => federation.subscriptions(request);
export const DELETE = (request: Request) => federation.subscriptions(request);

const wrongMethod = (request: Request) => federation.methodNotAllowed(request, ["POST", "DELETE"]);

export { wrongMethod as GET, wrongMethod as PUT, wrongMethod as PATCH };
