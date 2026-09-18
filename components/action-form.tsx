"use client";

import { Alert, AlertContent, AlertDescription, Button, Form } from "@heroui/react";
import { useActionState, type ComponentProps, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

export interface ActionState {
  ok: boolean;
  message: string | null;
}

type Action = (previous: ActionState, form: FormData) => Promise<ActionState>;

/** A form bound to a Server Action that reports what the action answered. */
export function ActionForm({ action, children, className }: { action: Action; children: ReactNode; className?: string }) {
  const [state, formAction] = useActionState(action, { ok: true, message: null });
  return (
    <Form action={formAction} className={className ?? "flex flex-col gap-4"}>
      {state.message !== null && (
        <Alert status={state.ok ? "success" : "danger"}>
          <AlertContent>
            <AlertDescription>{state.message}</AlertDescription>
          </AlertContent>
        </Alert>
      )}
      {children}
    </Form>
  );
}

export function SubmitButton({ children, pendingLabel, ...props }: ComponentProps<typeof Button> & { pendingLabel?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" isDisabled={pending} {...props}>
      {pending ? (pendingLabel ?? "Working…") : children}
    </Button>
  );
}
