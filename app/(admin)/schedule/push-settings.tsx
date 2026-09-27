"use client";

import { ActionForm, SubmitButton } from "@/components/action-form";
import { setPushEnabledAction } from "./actions";

export function PushSettings({ enabled }: { enabled: boolean }) {
  return (
    <ActionForm action={setPushEnabledAction} className="flex flex-col gap-3">
      <input type="hidden" name="enabled" value={enabled ? "no" : "yes"} />
      <p className="text-muted text-sm">
        {enabled
          ? "Offered. The database checks every minute for deliveries that are due and calls this node's delivery route only when there are some."
          : "Not offered. Switching it on adds a job that runs every minute; it makes a request only when a delivery is due. Needs the hourly sync schedule, whose secret it uses."}
      </p>
      <SubmitButton variant={enabled ? "secondary" : "primary"} size="sm" className="self-start">
        {enabled ? "Stop offering push subscriptions" : "Offer push subscriptions"}
      </SubmitButton>
    </ActionForm>
  );
}
