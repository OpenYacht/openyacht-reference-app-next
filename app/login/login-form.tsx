"use client";

import { FieldError, Input, Label, TextField } from "@heroui/react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { signInAction } from "./actions";

export function LoginForm() {
  return (
    <ActionForm action={signInAction} className="flex flex-col gap-5">
      <TextField name="email" type="email" isRequired autoComplete="username">
        <Label>Email</Label>
        <Input />
        <FieldError />
      </TextField>
      <TextField name="password" type="password" isRequired autoComplete="current-password">
        <Label>Password</Label>
        <Input />
        <FieldError />
      </TextField>
      <SubmitButton variant="primary" pendingLabel="Signing in…">
        Sign in
      </SubmitButton>
    </ActionForm>
  );
}
