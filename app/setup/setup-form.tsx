"use client";

import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertTitle,
  Button,
  Checkbox,
  CheckboxContent,
  CheckboxControl,
  CheckboxIndicator,
  Description,
  FieldError,
  Form,
  Input,
  Label,
  Radio,
  RadioContent,
  RadioControl,
  RadioGroup,
  RadioIndicator,
  TextField,
} from "@heroui/react";
import { useActionState } from "react";
import { completeSetupAction, type SetupFormState } from "./actions";

const initialState: SetupFormState = { message: null };

export function SetupForm({ domain, disposable, minPasswordLength }: { domain: string; disposable: boolean; minPasswordLength: number }) {
  const [state, action, pending] = useActionState(completeSetupAction, initialState);

  return (
    <Form action={action} className="flex flex-col gap-6">
      {state.message !== null && (
        <Alert status="danger">
          <AlertContent>
            <AlertTitle>Setup did not complete</AlertTitle>
            <AlertDescription>{state.message}</AlertDescription>
          </AlertContent>
        </Alert>
      )}

      <TextField name="setup_token" type="password" isRequired autoComplete="off">
        <Label>Setup token</Label>
        <Input />
        <Description>The value of SETUP_TOKEN in this deployment&apos;s environment.</Description>
        <FieldError />
      </TextField>

      <TextField name="email" type="email" isRequired autoComplete="username">
        <Label>Administrator email</Label>
        <Input />
        <FieldError />
      </TextField>

      <TextField name="password" type="password" isRequired minLength={minPasswordLength} autoComplete="new-password">
        <Label>Password</Label>
        <Input />
        <Description>At least {minPasswordLength} characters.</Description>
        <FieldError />
      </TextField>

      <TextField name="password_confirmation" type="password" isRequired autoComplete="new-password">
        <Label>Confirm password</Label>
        <Input />
        <FieldError />
      </TextField>

      {/* Not marked required: a default is always selected, and HeroUI 3.2 paints the required asterisk on every option's label. */}
      <RadioGroup name="identity_mode" defaultValue={disposable ? "trial" : "production"}>
        <Label>What is this node for?</Label>
        {/* HeroUI anatomy: the content row holds the control and its label; the description is a sibling below it. */}
        <Radio value="trial">
          <RadioContent>
            <RadioControl>
              <RadioIndicator />
            </RadioControl>
            <Label>Trying it out</Label>
          </RadioContent>
          <Description>A disposable node. Partner only with nodes you are prepared to purge.</Description>
        </Radio>
        <Radio value="production" isDisabled={disposable}>
          <RadioContent>
            <RadioControl>
              <RadioIndicator />
            </RadioControl>
            <Label>A real node</Label>
          </RadioContent>
          <Description>
            {disposable
              ? `Not available: ${domain} is a platform-issued hostname, not a domain you own.`
              : `${domain} is a domain this business controls and intends to keep.`}
          </Description>
        </Radio>
      </RadioGroup>

      <Checkbox name="identity_acknowledged" value="yes" isRequired>
        <CheckboxContent>
          <CheckboxControl>
            <CheckboxIndicator />
          </CheckboxControl>
          <Label>
            I understand that <strong>{domain}</strong> becomes this node&apos;s permanent identity and cannot be renamed.
          </Label>
        </CheckboxContent>
      </Checkbox>

      <Button type="submit" variant="primary" isDisabled={pending}>
        {pending ? "Setting up…" : "Create administrator and generate keys"}
      </Button>
    </Form>
  );
}
