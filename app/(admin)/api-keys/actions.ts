"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/action-form";
import { requirePermission } from "@/lib/auth/session";
import { hashApiKey } from "@/lib/data-api/auth";
import { userClient } from "@/lib/supabase/server";

export async function createApiKeyAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  await requirePermission("api-keys.manage");
  const name = String(form.get("name") ?? "").trim();
  if (name === "") return { ok: false, message: "Name the key after what will use it." };
  const rate = Number.parseInt(String(form.get("rate_per_minute") ?? "60"), 10);
  if (!Number.isInteger(rate) || rate < 1 || rate > 10000) return { ok: false, message: "The rate is requests per minute, 1 to 10000." };

  // 32 random bytes. Only the digest is stored; the plaintext exists in this
  // response and nowhere else.
  const plaintext = `oyk_${randomBytes(32).toString("base64url")}`;
  const { error } = await (
    await userClient()
  ).rpc("create_api_key", {
    p_name: name,
    p_prefix: plaintext.slice(0, 12),
    p_key_hash: hashApiKey(plaintext),
    p_rate_per_minute: rate,
  });
  if (error) return { ok: false, message: error.message };
  revalidatePath("/api-keys");
  return {
    ok: true,
    message: "Copy the key now: it is not stored and cannot be shown again. Send it in the X-API-Key header, from a server, never from a browser.",
    code: plaintext,
  };
}

export async function revokeApiKeyAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  await requirePermission("api-keys.manage");
  if (form.get("confirmed") !== "yes") return { ok: false, message: "Confirm that the key is to be revoked." };
  const { error } = await (await userClient()).rpc("revoke_api_key", { p_key_id: Number(form.get("key_id")) });
  if (error) return { ok: false, message: error.message };
  revalidatePath("/api-keys");
  return { ok: true, message: "Revoked. Requests with it are refused from now on." };
}
