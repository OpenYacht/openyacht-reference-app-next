"use server";

import { redirect } from "next/navigation";
import type { ActionState } from "@/components/action-form";
import { checkSetupReadiness, isDisposableDomain, MIN_PASSWORD_LENGTH, runSetup, setupTokenMatches } from "@/lib/node/setup";
import { isSetupComplete } from "@/lib/node/setup-state";

export async function completeSetupAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  // A Server Action is a public POST endpoint; nothing here relies on the
  // proxy or on the form having been rendered.
  if (await isSetupComplete()) return { ok: false, message: "This node has already been set up." };

  const readiness = await checkSetupReadiness();
  if (readiness.identity === null || readiness.problems.length > 0) {
    return { ok: false, message: "The configuration is incomplete. Reload the page for the list of problems." };
  }

  if (!setupTokenMatches(String(form.get("setup_token") ?? ""))) return { ok: false, message: "The setup token is not correct." };

  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, message: "Enter a valid email address." };
  if (password.length < MIN_PASSWORD_LENGTH) return { ok: false, message: `The password needs at least ${MIN_PASSWORD_LENGTH} characters.` };
  if (password !== String(form.get("password_confirmation") ?? "")) return { ok: false, message: "The two passwords do not match." };

  if (form.get("identity_acknowledged") !== "yes") {
    return { ok: false, message: "Confirm that you understand the identity domain is permanent." };
  }
  const requestedMode = form.get("identity_mode") === "production" ? "production" : "trial";
  if (requestedMode === "production" && isDisposableDomain(readiness.identity.domain)) {
    return { ok: false, message: `${readiness.identity.domain} is a platform-issued hostname and can only be used as a trial node.` };
  }

  const result = await runSetup({ email, password, identity: readiness.identity, mode: requestedMode });
  if (!result.ok) return { ok: false, message: result.message };

  redirect("/login?setup=complete");
}
