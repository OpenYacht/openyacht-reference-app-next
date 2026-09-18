// Every other path under /openyacht/v1/ — answers NOT_FOUND in the error
// envelope (API-9) rather than the application's HTML 404 page. Real endpoints
// are added as sibling routes; a more specific route always wins over this one.
import { federation } from "@/lib/federation/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const notFound = (request: Request) => federation.notFound(request);

export { notFound as GET, notFound as POST, notFound as PUT, notFound as PATCH, notFound as DELETE };
