// GET /.well-known/openyacht — the discovery document (FP-1).
// Node runtime: federation code uses node:crypto, and signature verification needs the raw request bytes.
import { federation } from "@/lib/federation/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) => federation.wellKnown(request);
