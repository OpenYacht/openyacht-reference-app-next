// POST /openyacht/v1/partners/request — a signed partnership request (FP-13).
import { federation } from "@/lib/federation/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) => federation.partnersRequest(request);

const wrongMethod = (request: Request) => federation.methodNotAllowed(request, ["POST"]);

export { wrongMethod as GET, wrongMethod as PUT, wrongMethod as PATCH, wrongMethod as DELETE };
