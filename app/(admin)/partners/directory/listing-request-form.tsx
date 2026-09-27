"use client";

import { Description, Label, Radio, RadioContent, RadioControl, RadioGroup, RadioIndicator } from "@heroui/react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { listingRequestAction } from "./actions";

const ACTIONS = [
  ["list", "List this node", "Add it to the directory."],
  ["amend", "Amend its entry", "Change its name, website or country there."],
  ["delist", "Delist it", "Remove it from the directory."],
] as const;

export function ListingRequestForm({ listed }: { listed: boolean }) {
  return (
    <ActionForm action={listingRequestAction} className="flex flex-col gap-3">
      <RadioGroup name="action" defaultValue={listed ? "amend" : "list"}>
        <Label>Request</Label>
        {ACTIONS.map(([value, label, description]) => (
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
        Sign the request
      </SubmitButton>
    </ActionForm>
  );
}
