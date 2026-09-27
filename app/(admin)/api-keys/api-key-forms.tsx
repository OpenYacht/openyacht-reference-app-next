"use client";

import { Checkbox, CheckboxContent, CheckboxControl, CheckboxIndicator, Description, FieldError, Input, Label, TextField } from "@heroui/react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { createApiKeyAction, revokeApiKeyAction } from "./actions";

export function CreateApiKeyForm() {
  return (
    <ActionForm action={createApiKeyAction} className="flex flex-col gap-4" resetOnSuccess>
      <TextField name="name" isRequired autoComplete="off">
        <Label>Name</Label>
        <Input placeholder="Brokerage website" />
        <FieldError />
      </TextField>
      <TextField name="rate_per_minute" type="number" defaultValue="60" isRequired>
        <Label>Requests per minute</Label>
        <Input />
        <Description>Above this the API answers 429 with Retry-After.</Description>
        <FieldError />
      </TextField>
      <SubmitButton variant="primary" className="self-start">
        Create key
      </SubmitButton>
    </ActionForm>
  );
}

export function RevokeApiKeyForm({ keyId }: { keyId: number }) {
  return (
    <ActionForm action={revokeApiKeyAction} className="flex flex-col gap-2">
      <input type="hidden" name="key_id" value={keyId} />
      <Checkbox name="confirmed" value="yes">
        <CheckboxContent>
          <CheckboxControl>
            <CheckboxIndicator />
          </CheckboxControl>
          <Label>Revoke</Label>
        </CheckboxContent>
      </Checkbox>
      <SubmitButton variant="danger" size="sm" className="self-start">
        Revoke key
      </SubmitButton>
    </ActionForm>
  );
}
