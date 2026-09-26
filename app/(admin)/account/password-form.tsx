"use client";

import { Description, FieldError, Input, Label, TextField } from "@heroui/react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { changePasswordAction } from "./actions";

export function PasswordForm({ email }: { email: string }) {
  return (
    <ActionForm action={changePasswordAction} className="flex flex-col gap-5" resetOnSuccess>
      {/* Lets a password manager file the new password under the right account. */}
      <input type="email" name="username" value={email} autoComplete="username" readOnly hidden />
      <TextField name="password" type="password" isRequired autoComplete="new-password">
        <Label>New password</Label>
        <Input />
        <Description>At least 12 characters.</Description>
        <FieldError />
      </TextField>
      <TextField name="password_confirmation" type="password" isRequired autoComplete="new-password">
        <Label>Repeat it</Label>
        <Input />
        <FieldError />
      </TextField>
      <SubmitButton variant="primary" className="self-start">
        Save password
      </SubmitButton>
    </ActionForm>
  );
}
