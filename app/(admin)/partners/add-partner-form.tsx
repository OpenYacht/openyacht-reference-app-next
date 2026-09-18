"use client";

import {
  Checkbox,
  CheckboxContent,
  CheckboxControl,
  CheckboxIndicator,
  Description,
  FieldError,
  Input,
  Label,
  TextArea,
  TextField,
} from "@heroui/react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { PolicyOptions } from "@/components/policy-options";
import { addPartnerAction } from "./actions";

export function AddPartnerForm({ nodeName, contactEmail }: { nodeName: string; contactEmail: string }) {
  return (
    <ActionForm action={addPartnerAction} className="flex flex-col gap-5">
      <TextField name="domain" isRequired autoComplete="off">
        <Label>Partner&apos;s identity domain</Label>
        <Input placeholder="openyacht.their-brokerage.example" />
        <Description>A bare hostname. Its discovery document is fetched over verified TLS and trusted on first use.</Description>
        <FieldError />
      </TextField>

      <TextField name="message" isRequired defaultValue={`${nodeName} would like to federate listings with you via OpenYacht.`}>
        <Label>Message to their administrator</Label>
        <TextArea rows={3} />
        <Description>Sent as a signed partnership request. They see this before deciding whether to approve you.</Description>
        <FieldError />
      </TextField>

      <TextField name="contact_email" type="email" isRequired defaultValue={contactEmail}>
        <Label>Contact email</Label>
        <Input />
        <Description>An address a person there can reply to.</Description>
        <FieldError />
      </TextField>

      <PolicyOptions defaultValue="hold" />

      <Checkbox name="pin_key" value="yes" defaultSelected>
        <CheckboxContent>
          <CheckboxControl>
            <CheckboxIndicator />
          </CheckboxControl>
          <Label>Pin their current signing key</Label>
        </CheckboxContent>
        <Description>
          Safer: a takeover of their domain cannot silently swap their key. The cost is that when they rotate keys, you confirm the new one here
          before their requests are accepted again.
        </Description>
      </Checkbox>

      <SubmitButton variant="primary" pendingLabel="Contacting partner…">
        Add partner and send request
      </SubmitButton>
    </ActionForm>
  );
}
