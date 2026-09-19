"use server";

import { revalidatePath } from "next/cache";
import { generateKeypair } from "@/federation";
import type { ActionState } from "@/components/action-form";
import { requireRole } from "@/lib/auth/session";
import { userClient } from "@/lib/supabase/server";

// Rotating the signing key. Spec: federation-protocol.md §Key Rotation.
//
// Nobody is contacted, in either mode: the new key is simply what the domain
// serves from now on. A partner that pinned the old key is the exception the
// spec intends — its administrator confirms the new one by hand.

const failed = (message: string): ActionState => ({ ok: false, message });

export async function rotateKeyAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  await requireRole("super_admin");
  const emergency = form.get("mode") === "emergency";
  const note = String(form.get("note") ?? "").trim();
  if (emergency && note === "") return failed("Say what happened. An emergency rotation is recorded with the key it replaces.");
  // One click must not be enough for either: a rotation cannot be taken back.
  if (form.get("confirmed") !== "yes")
    return failed(emergency ? "Confirm that the current key is to be revoked immediately." : "Confirm the rotation.");

  // The keypair is made here and the seed handed straight to the database,
  // which puts it in Vault (FP-4). As the signed-in user: the function checks
  // for a super admin itself, so nothing here needs the service role.
  const keypair = generateKeypair();
  const { error } = await (
    await userClient()
  ).rpc("rotate_signing_key", {
    p_key_id: keypair.keyId,
    p_public_key: keypair.publicKey,
    p_private_key: keypair.privateSeed.toString("base64"),
    p_emergency: emergency,
    p_note: note === "" ? null : note,
  });
  keypair.privateSeed.fill(0);
  if (error) return failed(`The key was not rotated: ${error.message}`);

  revalidatePath("/");
  return {
    ok: true,
    message: emergency
      ? `Key ${keypair.keyId} now signs, and every earlier key is revoked. Partners recover on their next request; one that pinned the old key must confirm the new one.`
      : `Key ${keypair.keyId} now signs. The previous key stays published for 48 hours, then is revoked. A partner that pinned it must confirm the new one.`,
  };
}
