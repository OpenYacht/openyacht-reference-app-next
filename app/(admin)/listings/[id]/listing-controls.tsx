"use client";

import {
  Checkbox,
  CheckboxContent,
  CheckboxControl,
  CheckboxIndicator,
  Description,
  Label,
  Radio,
  RadioContent,
  RadioControl,
  RadioGroup,
  RadioIndicator,
} from "@heroui/react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { deleteDraftAction, setSharingAction, setStatusAction } from "../actions";

const TRANSITIONS: Record<string, { to: string; label: string; variant: "primary" | "secondary" | "danger-soft" }[]> = {
  draft: [
    { to: "active", label: "Make active", variant: "primary" },
    { to: "withdrawn", label: "Withdraw", variant: "danger-soft" },
  ],
  active: [
    { to: "under_offer", label: "Mark under offer", variant: "secondary" },
    { to: "sold", label: "Mark sold", variant: "danger-soft" },
    { to: "withdrawn", label: "Withdraw", variant: "danger-soft" },
  ],
  under_offer: [
    { to: "active", label: "Back to active", variant: "secondary" },
    { to: "sold", label: "Mark sold", variant: "danger-soft" },
    { to: "withdrawn", label: "Withdraw", variant: "danger-soft" },
  ],
};

export function StatusControls({ listingId, status, canDelete }: { listingId: number; status: string; canDelete: boolean }) {
  const next = TRANSITIONS[status] ?? [];
  if (next.length === 0) {
    return (
      <p className="text-muted text-sm">This listing has ended, and that is final. If the vessel returns to the market, it gets a new listing.</p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3">
        {next.map((transition) => (
          <ActionForm key={transition.to} action={setStatusAction} className="flex flex-col gap-2">
            <input type="hidden" name="listing_id" value={listingId} />
            <input type="hidden" name="from" value={status} />
            <input type="hidden" name="to" value={transition.to} />
            <SubmitButton variant={transition.variant}>{transition.label}</SubmitButton>
          </ActionForm>
        ))}
      </div>
      {status === "draft" && canDelete && (
        <ActionForm action={deleteDraftAction}>
          <input type="hidden" name="listing_id" value={listingId} />
          <SubmitButton variant="danger" className="self-start">
            Delete draft
          </SubmitButton>
          <p className="text-muted text-xs">
            Only a draft can be deleted. Once a listing has been distributed it ends by being withdrawn or sold, which partners are told about.
          </p>
        </ActionForm>
      )}
    </div>
  );
}

const AUDIENCES = [
  ["everyone", "Every verified partner", "Including partners approved later."],
  ["selected", "Selected partners only", "Those ticked below."],
  ["none", "Nobody", "Hidden from every partner. Your selection below is kept for when you share it again."],
] as const;

export function SharingForm({
  listingId,
  audience,
  shared,
  partners,
}: {
  listingId: number;
  audience: string;
  shared: number[];
  partners: { id: number; node_name: string; domain: string }[];
}) {
  return (
    <ActionForm action={setSharingAction}>
      <input type="hidden" name="listing_id" value={listingId} />
      <RadioGroup name="audience" defaultValue={audience}>
        <Label>Who receives this listing</Label>
        {AUDIENCES.map(([value, label, description]) => (
          <Radio key={value} value={value}>
            <RadioContent>
              <RadioControl>
                <RadioIndicator />
              </RadioControl>
              <Label>{label}</Label>
            </RadioContent>
            <Description>{description}</Description>
          </Radio>
        ))}
      </RadioGroup>
      {partners.length === 0 ? (
        <p className="text-muted text-sm">There are no verified partners yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {partners.map((partner) => (
            <Checkbox key={partner.id} name="partner_ids" value={String(partner.id)} defaultSelected={shared.includes(partner.id)}>
              <CheckboxContent>
                <CheckboxControl>
                  <CheckboxIndicator />
                </CheckboxControl>
                <Label>
                  {partner.node_name} <span className="text-muted font-mono text-xs">{partner.domain}</span>
                </Label>
              </CheckboxContent>
            </Checkbox>
          ))}
        </div>
      )}
      <SubmitButton variant="secondary" className="self-start">
        Save sharing
      </SubmitButton>
    </ActionForm>
  );
}
