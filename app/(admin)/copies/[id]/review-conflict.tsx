"use client";

import { Checkbox, CheckboxContent, CheckboxControl, CheckboxIndicator, Label } from "@heroui/react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { reviewConflictAction } from "../actions";

export function ReviewConflict({ canonicalUri }: { canonicalUri: string }) {
  return (
    <ActionForm action={reviewConflictAction} className="flex flex-col gap-3">
      <input type="hidden" name="canonical_uri" value={canonicalUri} />
      <Checkbox name="confirmed" value="yes" isRequired>
        <CheckboxContent>
          <CheckboxControl>
            <CheckboxIndicator />
          </CheckboxControl>
          <Label>I have compared both listings and this one may be displayed</Label>
        </CheckboxContent>
      </Checkbox>
      <SubmitButton variant="secondary" size="sm" className="self-start">
        Record the review
      </SubmitButton>
    </ActionForm>
  );
}
