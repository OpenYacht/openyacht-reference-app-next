"use client";

import { Alert, AlertContent, AlertDescription, Button, FieldError, Form, Input, Label, TextField } from "@heroui/react";
import { useActionState } from "react";
import { signInAction, type LoginFormState } from "./actions";

const initialState: LoginFormState = { message: null };

export function LoginForm() {
  const [state, action, pending] = useActionState(signInAction, initialState);

  return (
    <Form action={action} className="flex flex-col gap-5">
      {state.message !== null && (
        <Alert status="danger">
          <AlertContent>
            <AlertDescription>{state.message}</AlertDescription>
          </AlertContent>
        </Alert>
      )}
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
      <Button type="submit" variant="primary" isDisabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </Form>
  );
}
