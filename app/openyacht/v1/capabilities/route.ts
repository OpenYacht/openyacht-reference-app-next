// GET /openyacht/v1/capabilities — unsigned (API-6).
import { federation } from "@/lib/federation/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) => federation.capabilities(request);
