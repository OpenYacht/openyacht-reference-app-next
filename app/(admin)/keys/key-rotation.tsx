"use client";

import { Checkbox, CheckboxContent, CheckboxControl, CheckboxIndicator, Description, Input, Label, TextField } from "@heroui/react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { rotateKeyAction } from "./actions";

export function KeyRotation() {
  return (
    <div className="border-border mt-5 flex flex-col gap-6 border-t pt-5">
      <ActionForm action={rotateKeyAction} className="flex flex-col gap-3" resetOnSuccess>
        <input type="hidden" name="mode" value="routine" />
        <div>
          <h3 className="text-sm font-semibold">Routine rotation</h3>
          <p className="text-muted text-sm">
            A new key starts signing at once and the current one stays published for 48 hours, so no partner meets a key it cannot find. Nobody needs
            telling. A partner that pinned the current key will hold this node&apos;s requests until its administrator confirms the new one.
          </p>
        </div>
        <Checkbox name="confirmed" value="yes">
          <CheckboxContent>
            <CheckboxControl>
              <CheckboxIndicator />
            </CheckboxControl>
            <Label>Start signing with a new key</Label>
          </CheckboxContent>
        </Checkbox>
        <SubmitButton variant="secondary" className="self-start">
          Rotate the signing key
        </SubmitButton>
      </ActionForm>

      <ActionForm action={rotateKeyAction} className="flex flex-col gap-3" resetOnSuccess>
        <input type="hidden" name="mode" value="emergency" />
        <div>
          <h3 className="text-sm font-semibold">Emergency rotation</h3>
          <p className="text-muted text-sm">
            For a key that may have been copied. Every earlier key is revoked immediately and its private half destroyed. A partner&apos;s next
            request fails once, makes it fetch the new key, and succeeds.
          </p>
        </div>
        <TextField name="note" isRequired>
          <Label>What happened</Label>
          <Input />
          <Description>Kept with the revoked key.</Description>
        </TextField>
        <Checkbox name="confirmed" value="yes">
          <CheckboxContent>
            <CheckboxControl>
              <CheckboxIndicator />
            </CheckboxControl>
            <Label>Revoke the current key now, with no overlap</Label>
          </CheckboxContent>
        </Checkbox>
        <SubmitButton variant="danger" className="self-start">
          Revoke and replace
        </SubmitButton>
      </ActionForm>
    </div>
  );
}
