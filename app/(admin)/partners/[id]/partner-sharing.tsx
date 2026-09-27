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
import { setDirectSharesAction, setSharingScopeAction } from "../actions";

const SCOPES = [
  ["standard", "Standard", "Every listing shared with everyone, and whatever is shared with them below or through a group."],
  ["curated", "Curated", "Only what is shared with them below or through a group: a show organiser, a trial, a press feed."],
] as const;

export function SharingScopeForm({ partnerId, scope }: { partnerId: string; scope: string }) {
  return (
    <ActionForm action={setSharingScopeAction} className="flex flex-col gap-3">
      <input type="hidden" name="partner_id" value={partnerId} />
      <RadioGroup name="sharing_scope" defaultValue={scope}>
        <Label>Sharing scope</Label>
        {SCOPES.map(([value, label, description]) => (
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
      <SubmitButton variant="secondary" size="sm" className="self-start">
        Save scope
      </SubmitButton>
    </ActionForm>
  );
}

export interface PickerListing {
  id: number;
  name: string;
  status: string;
  audience: string;
  direct: boolean;
  /** Groups of this partner the listing is shared with. Shown, not editable here. */
  viaGroups: string[];
  /** The same vessel's listing of the other type is shared with this partner and this one is not. */
  twinShared: boolean;
}

export function DirectSharesForm({ partnerId, type, listings }: { partnerId: string; type: "sale" | "charter"; listings: PickerListing[] }) {
  return (
    <ActionForm action={setDirectSharesAction} className="flex flex-col gap-3">
      <input type="hidden" name="partner_id" value={partnerId} />
      <input type="hidden" name="listing_type" value={type} />
      <h3 className="text-sm font-semibold">{type === "sale" ? "Sale listings" : "Charter listings"}</h3>
      {listings.length === 0 ? (
        <p className="text-muted text-sm">None.</p>
      ) : (
        listings.map((listing) => (
          <Checkbox key={listing.id} name="listing_ids" value={String(listing.id)} defaultSelected={listing.direct}>
            <CheckboxContent>
              <CheckboxControl>
                <CheckboxIndicator />
              </CheckboxControl>
              <Label>{listing.name}</Label>
            </CheckboxContent>
            <Description>
              {listing.status}, audience {listing.audience}
              {listing.viaGroups.length > 0 && `; also shared through ${listing.viaGroups.join(", ")}`}
              {/* The twins carry different prices: sharing the wrong one shows the wrong one. */}
              {listing.twinShared && `; the ${type === "sale" ? "charter" : "sale"} listing of this vessel is shared with them`}
            </Description>
          </Checkbox>
        ))
      )}
      <SubmitButton variant="secondary" size="sm" className="self-start">
        Save {type} shares
      </SubmitButton>
    </ActionForm>
  );
}
