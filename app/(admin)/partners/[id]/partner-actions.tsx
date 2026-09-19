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
import {
  introduceAction,
  refreshKeysAction,
  removePartnerAction,
  setFieldGroupsAction,
  setRateLimitAction,
  setPolicyAction,
  setTrustAction,
  syncNowAction,
} from "../actions";

const Id = ({ partnerId }: { partnerId: string }) => <input type="hidden" name="partner_id" value={partnerId} />;

export function SyncNow({ partnerId }: { partnerId: string }) {
  return (
    <ActionForm action={syncNowAction}>
      <Id partnerId={partnerId} />
      <SubmitButton variant="primary" pendingLabel="Synchronising…" className="self-start">
        Synchronise now
      </SubmitButton>
    </ActionForm>
  );
}

export function PolicyForm({ partnerId, policy }: { partnerId: string; policy: string }) {
  return (
    <ActionForm action={setPolicyAction}>
      <Id partnerId={partnerId} />
      <PolicyOptions defaultValue={policy} />
      <SubmitButton variant="secondary" className="self-start">
        Save policy
      </SubmitButton>
    </ActionForm>
  );
}

export function RefreshKeys({ partnerId, pinned }: { partnerId: string; pinned: boolean }) {
  return (
    <ActionForm action={refreshKeysAction}>
      <Id partnerId={partnerId} />
      {pinned && (
        <Checkbox name="confirm_pin" value="yes">
          <CheckboxContent>
            <CheckboxControl>
              <CheckboxIndicator />
            </CheckboxControl>
            <Label>I have confirmed their new key with them — move the pin to their current signing key</Label>
          </CheckboxContent>
          <Description>Compare key IDs over a channel you trust, such as a phone call. Without this, a rotated key stays rejected.</Description>
        </Checkbox>
      )}
      <SubmitButton variant="secondary" pendingLabel="Fetching…" className="self-start">
        Refresh keys from their discovery document
      </SubmitButton>
    </ActionForm>
  );
}

export function Introduce({ partnerId, nodeName, contactEmail, sent }: { partnerId: string; nodeName: string; contactEmail: string; sent: boolean }) {
  return (
    <ActionForm action={introduceAction}>
      <Id partnerId={partnerId} />
      <TextField name="message" isRequired defaultValue={`${nodeName} would like to federate listings with you via OpenYacht.`}>
        <Label>Message</Label>
        <TextArea rows={2} />
        <FieldError />
      </TextField>
      <TextField name="contact_email" type="email" isRequired defaultValue={contactEmail}>
        <Label>Contact email</Label>
        <Input />
        <FieldError />
      </TextField>
      <SubmitButton variant="secondary" pendingLabel="Sending…" className="self-start">
        {sent ? "Resend partnership request" : "Send partnership request"}
      </SubmitButton>
    </ActionForm>
  );
}

export function TrustAndRemoval({ partnerId, trustLevel, removable }: { partnerId: string; trustLevel: string; removable: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <ActionForm action={setTrustAction}>
        <Id partnerId={partnerId} />
        <input type="hidden" name="trust_level" value={trustLevel === "verified" ? "blocked" : "verified"} />
        <SubmitButton variant={trustLevel === "verified" ? "danger-soft" : "primary"} className="self-start">
          {trustLevel === "verified" ? "Block this partner" : "Approve this partner"}
        </SubmitButton>
      </ActionForm>
      {removable && (
        <ActionForm action={removePartnerAction}>
          <Id partnerId={partnerId} />
          <SubmitButton variant="danger" className="self-start">
            Remove partner
          </SubmitButton>
          <p className="text-muted text-xs">
            Possible only because nothing has been received from it yet. After that, a partnership ends by blocking.
          </p>
        </ActionForm>
      )}
    </div>
  );
}

const FIELD_GROUPS = [
  ["pricing", "Pricing", "The asking price and currency, and charter rates."],
  ["history", "Price history", "Every asking price the listing has had."],
  ["location_exact", "Exact location", "The marina or berth, and coordinates. The public wording is always sent."],
  ["vessel_identifiers", "Vessel identifiers", "HIN, IMO, MMSI and official number."],
  ["documents", "Documents", "Brochures, plans and other files."],
  ["media_original", "Original media", "Full-resolution originals instead of the derived renditions."],
] as const;

export function FieldGroupsForm({ partnerId, granted }: { partnerId: string; granted: string[] }) {
  return (
    <ActionForm action={setFieldGroupsAction}>
      <Id partnerId={partnerId} />
      <div className="flex flex-col gap-3">
        {FIELD_GROUPS.map(([value, label, description]) => (
          <Checkbox key={value} name="field_groups" value={value} defaultSelected={granted.includes(value)}>
            <CheckboxContent>
              <CheckboxControl>
                <CheckboxIndicator />
              </CheckboxControl>
              <Label>{label}</Label>
            </CheckboxContent>
            <Description>{description}</Description>
          </Checkbox>
        ))}
      </div>
      <SubmitButton variant="secondary" className="self-start">
        Save
      </SubmitButton>
    </ActionForm>
  );
}

export function RateLimitForm({ partnerId, ratePerHour, defaultPerHour }: { partnerId: string; ratePerHour: number | null; defaultPerHour: number }) {
  return (
    <ActionForm action={setRateLimitAction}>
      <Id partnerId={partnerId} />
      <TextField name="rate_per_hour" defaultValue={ratePerHour === null ? "" : String(ratePerHour)} className="max-w-xs">
        <Label>Requests per hour</Label>
        <Input inputMode="numeric" placeholder={String(defaultPerHour)} />
        <Description>Empty for the default of {defaultPerHour}. The whole figure can be spent in one burst, then refills evenly.</Description>
      </TextField>
      <SubmitButton variant="secondary" className="self-start">
        Save limit
      </SubmitButton>
    </ActionForm>
  );
}
