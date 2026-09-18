import "server-only";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { generateKeypair, IdentityConfigError, parseNodeIdentity, type NodeIdentity } from "@/federation";
import { MissingEnvError, optionalEnv, supabasePublishableKey, supabaseSecretKey, supabaseUrl } from "@/lib/env";
import { serviceClient } from "@/lib/supabase/service";
import { supabaseNodeStore } from "./store";

export type IdentityMode = "trial" | "production";

// Hostnames handed out by hosting platforms and tunnels. They work as a
// federation identity, and that is the trap: the identity domain is permanent
// in every canonical URI a partner ever stores, and these names are not yours
// to keep. A node on one of them can only be set up as a trial.
const DISPOSABLE_SUFFIXES = [".vercel.app", ".netlify.app", ".trycloudflare.com", ".ngrok-free.app", ".ngrok.app", ".ngrok.io", ".pages.dev"];

export const isDisposableDomain = (domain: string) => DISPOSABLE_SUFFIXES.some((suffix) => domain.endsWith(suffix));

export const MIN_PASSWORD_LENGTH = 12;

export interface SetupReadiness {
  /** Null when the identity variables are unusable; the reasons are in `problems`. */
  identity: NodeIdentity | null;
  /** Everything that must be fixed in the environment before setup can run. Empty means ready. */
  problems: string[];
}

/** Checks the whole configuration and reports every problem at once, not one per attempt. */
export async function checkSetupReadiness(): Promise<SetupReadiness> {
  const problems: string[] = [];

  let identity: NodeIdentity | null = null;
  try {
    identity = parseNodeIdentity(process.env);
  } catch (error) {
    if (!(error instanceof IdentityConfigError)) throw error;
    problems.push(...error.problems);
  }

  if (optionalEnv("SETUP_TOKEN") === undefined) {
    problems.push("SETUP_TOKEN is not set. Without it, the first stranger to find this deployment could claim it.");
  }

  let supabaseConfigured = true;
  for (const read of [supabaseUrl, supabasePublishableKey, supabaseSecretKey]) {
    try {
      read();
    } catch (error) {
      if (!(error instanceof MissingEnvError)) throw error;
      problems.push(error.message);
      supabaseConfigured = false;
    }
  }

  if (supabaseConfigured) {
    try {
      await supabaseNodeStore.getState();
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { identity, problems };
}

export function setupTokenMatches(candidate: string): boolean {
  const expected = optionalEnv("SETUP_TOKEN");
  if (expected === undefined) return false;
  // Compare digests: timingSafeEqual needs equal lengths, and hashing first
  // keeps the token's length from leaking through that requirement.
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(candidate), digest(expected));
}

export interface SetupInput {
  email: string;
  password: string;
  identity: NodeIdentity;
  mode: IdentityMode;
}

/**
 * Creates the first administrator, the node UUID (FP-5) and the first signing
 * key (FP-3). The database half is one transaction — complete_setup() — and if
 * it fails the user created a moment earlier is removed again, so a failed
 * attempt can simply be retried.
 */
export async function runSetup(input: SetupInput): Promise<{ ok: true } | { ok: false; message: string }> {
  const supabase = serviceClient();

  const { data: created, error: createError } = await supabase.auth.admin.createUser({
    email: input.email,
    password: input.password,
    // The administrator proved control of the deployment with SETUP_TOKEN;
    // first login must not wait on mail delivery.
    email_confirm: true,
  });
  if (createError || !created.user)
    return { ok: false, message: `Could not create the administrator: ${createError?.message ?? "no user returned"}` };

  const keypair = generateKeypair();
  const { error: setupError } = await supabase.rpc("complete_setup", {
    p_admin_user_id: created.user.id,
    p_identity_domain: input.identity.domain,
    p_identity_mode: input.mode,
    p_node_uuid: randomUUID(),
    p_key_id: keypair.keyId,
    p_public_key: keypair.publicKey,
    // Goes straight into Supabase Vault (FP-4). It is never logged and never
    // returned to the browser.
    p_private_key: keypair.privateSeed.toString("base64"),
  });
  keypair.privateSeed.fill(0);

  if (setupError) {
    await supabase.auth.admin.deleteUser(created.user.id);
    return { ok: false, message: `Setup could not be completed: ${setupError.message}` };
  }
  return { ok: true };
}
