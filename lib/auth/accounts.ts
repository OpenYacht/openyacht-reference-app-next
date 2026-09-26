import "server-only";
import { serviceClient } from "@/lib/supabase/service";

// Accounts live in auth.users, which only the Auth admin API may create or
// delete, and that API needs the secret key. This module is the whole of what
// user management may do with it. Every caller has already asked the database,
// as the signed-in user, whether they may act on that account
// (public.can_manage_user / public.can_assign_role): the database decides, and
// this only carries out.
//
// No email is ever sent. Supabase's generateLink returns the token instead,
// and the administrator hands the link over however they like, so a node
// works without an SMTP provider configured.

export type LinkType = "invite" | "recovery";

/** Where a one-time link lands. It verifies the token only when the person presses a button, so a mail scanner prefetching the URL cannot spend it. */
export const confirmLink = (origin: string, tokenHash: string, type: LinkType) =>
  `${origin}/auth/confirm?${new URLSearchParams({ token_hash: tokenHash, type })}`;

/** Creates an account for `email` with no password, and the one-time token that lets its owner choose one. */
export async function createInvitedAccount(email: string): Promise<{ userId: string; tokenHash: string } | { error: string }> {
  const { data, error } = await serviceClient().auth.admin.generateLink({ type: "invite", email });
  if (error || !data.user) return { error: error?.message ?? "No account was returned." };
  return { userId: data.user.id, tokenHash: data.properties.hashed_token };
}

/** A one-time token that lets the account's owner choose a new password. */
export async function createRecoveryToken(userId: string): Promise<{ tokenHash: string } | { error: string }> {
  const admin = serviceClient().auth.admin;
  const { data: found, error: lookupError } = await admin.getUserById(userId);
  if (lookupError || !found.user?.email) return { error: lookupError?.message ?? "The account has no email address." };
  const { data, error } = await admin.generateLink({ type: "recovery", email: found.user.email });
  if (error) return { error: error.message };
  return { tokenHash: data.properties.hashed_token };
}

export async function deleteAccount(userId: string): Promise<{ error: string } | null> {
  const { error } = await serviceClient().auth.admin.deleteUser(userId);
  return error ? { error: error.message } : null;
}
