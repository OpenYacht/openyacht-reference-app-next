"use server";

import type { ActionState } from "@/components/action-form";
import { requirePermission } from "@/lib/auth/session";
import { signDirectoryRequest } from "@/lib/federation/consumer";

export async function listingRequestAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  await requirePermission("federation.manage");
  const value = String(form.get("action"));
  const action = value === "delist" || value === "amend" ? value : "list";
  const { token, signature } = await signDirectoryRequest(action);
  return {
    ok: true,
    message:
      "Submit these two lines to the directory's maintainers, as its README describes. They are checked against the keys this node publishes when they are received, and are valid for 30 days either side of today.",
    code: `token:     ${token}\nsignature: ${signature}`,
  };
}
