"use client";

import { Alert, AlertContent, AlertDescription, Button, Form } from "@heroui/react";
import { createContext, startTransition, use, useActionState, type ComponentProps, type FormEvent, type ReactNode } from "react";

export interface ActionState {
  ok: boolean;
  message: string | null;
}

type Action = (previous: ActionState, form: FormData) => Promise<ActionState>;

const PendingContext = createContext(false);

/**
 * A form bound to a Server Action that reports what the action answered.
 *
 * The action is called from `onSubmit` rather than passed as the form's
 * `action`. React resets a form whose `action` completes — including when the
 * action answered with a validation error, which would throw away everything
 * the user had typed over one mistyped field. Submitted this way the fields
 * keep their values, and the error appears above them.
 */
export function ActionForm({ action, children, className }: { action: Action; children: ReactNode; className?: string }) {
  const [state, formAction, pending] = useActionState(action, { ok: true, message: null });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(() => formAction(data));
  }

  return (
    <PendingContext value={pending}>
      <Form onSubmit={submit} className={className ?? "flex flex-col gap-4"}>
        {state.message !== null && (
          <Alert status={state.ok ? "success" : "danger"}>
            <AlertContent>
              <AlertDescription>{state.message}</AlertDescription>
            </AlertContent>
          </Alert>
        )}
        {children}
      </Form>
    </PendingContext>
  );
}

export function SubmitButton({ children, pendingLabel, ...props }: ComponentProps<typeof Button> & { pendingLabel?: string }) {
  const pending = use(PendingContext);
  return (
    <Button type="submit" isDisabled={pending} {...props}>
      {pending ? (pendingLabel ?? "Working…") : children}
    </Button>
  );
}
