"use client";

import { Description, Label, Radio, RadioContent, RadioControl, RadioGroup, RadioIndicator } from "@heroui/react";

const OPTIONS = [
  ["hold", "Hold for review", "Listings are stored and kept up to date, but none is displayed until you change this."],
  ["accept_matching", "Accept what is complete", "Display listings that arrive with a profile image and a price; hold the rest."],
  ["accept_all", "Accept everything", "Display every listing this partner shares."],
] as const;

/** The per-partner acceptance policy. Synchronising is not publishing: copies are stored under every policy. */
export function PolicyOptions({ defaultValue }: { defaultValue: string }) {
  return (
    <RadioGroup name="acceptance_policy" defaultValue={defaultValue}>
      <Label>What happens to this partner&apos;s listings</Label>
      {OPTIONS.map(([value, label, description]) => (
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
  );
}
