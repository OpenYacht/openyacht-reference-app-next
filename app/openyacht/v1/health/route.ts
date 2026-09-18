// GET /openyacht/v1/health — unsigned liveness check (API-6).
import { federation } from "@/lib/federation/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) => federation.health(request);
