"use client";

import { Checkbox, CheckboxContent, CheckboxControl, CheckboxIndicator, Label } from "@heroui/react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { scheduleSyncAction, unscheduleSyncAction } from "./actions";

export function SyncSchedule({ registered }: { registered: boolean }) {
  return (
    <div className="border-border mt-5 flex flex-col gap-6 border-t pt-5">
      <ActionForm action={scheduleSyncAction} className="flex flex-col gap-3">
        <p className="text-muted text-sm">
          {registered
            ? "Registering again copies this server's INTERNAL_API_SECRET to the database. Do it after changing the secret."
            : "The database calls this node's sync route once an hour, with this server's INTERNAL_API_SECRET, which is kept in Supabase Vault."}
        </p>
        <SubmitButton variant={registered ? "secondary" : "primary"} className="self-start">
          {registered ? "Register again" : "Schedule hourly sync"}
        </SubmitButton>
      </ActionForm>

      {registered && (
        <ActionForm action={unscheduleSyncAction} className="flex flex-col gap-3">
          <Checkbox name="confirmed" value="yes">
            <CheckboxContent>
              <CheckboxControl>
                <CheckboxIndicator />
              </CheckboxControl>
              <Label>Stop synchronising on a schedule</Label>
            </CheckboxContent>
          </Checkbox>
          <SubmitButton variant="danger" className="self-start">
            Stop the schedule
          </SubmitButton>
        </ActionForm>
      )}
    </div>
  );
}
