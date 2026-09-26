"use client";

import { ActionForm, SubmitButton } from "@/components/action-form";
import { confirmLinkAction } from "./actions";

export function ConfirmForm({ tokenHash, type }: { tokenHash: string; type: "invite" | "recovery" }) {
  return (
    <ActionForm action={confirmLinkAction} className="flex flex-col gap-4">
      <input type="hidden" name="token_hash" value={tokenHash} />
      <input type="hidden" name="type" value={type} />
      <p className="text-sm">Continue to choose {type === "invite" ? "a password for your account" : "a new password"}.</p>
      <SubmitButton variant="primary" pendingLabel="Checking the link…">
        Continue
      </SubmitButton>
    </ActionForm>
  );
}
