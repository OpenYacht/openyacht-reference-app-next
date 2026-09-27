"use client";

import { Checkbox, CheckboxContent, CheckboxControl, CheckboxIndicator, Description, FieldError, Input, Label, TextField } from "@heroui/react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { deleteGroupAction, saveGroupAction } from "../actions";

const nativeField = "border-border bg-field text-foreground mt-1 w-full rounded-xl border px-3 py-2 text-sm shadow-sm";

export interface GroupPartner {
  id: number;
  node_name: string;
  domain: string;
}

export function GroupForm({
  group,
  partners,
}: {
  group: { id: number; name: string; memberIds: number[]; acceptancePolicy: string | null } | null;
  partners: GroupPartner[];
}) {
  return (
    <ActionForm action={saveGroupAction} className="flex flex-col gap-4" resetOnSuccess={group === null}>
      {group !== null && <input type="hidden" name="group_id" value={group.id} />}
      <TextField name="name" isRequired defaultValue={group?.name ?? ""}>
        <Label>Name</Label>
        <Input />
        <FieldError />
      </TextField>
      <div className="flex flex-col gap-2">
        <Label>Members</Label>
        {partners.map((partner) => (
          <Checkbox key={partner.id} name="member_ids" value={String(partner.id)} defaultSelected={group?.memberIds.includes(partner.id) ?? false}>
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
      <label className="flex flex-col text-sm font-medium">
        Acceptance policy for members
        <select name="acceptance_policy" defaultValue={group?.acceptancePolicy ?? ""} className={nativeField}>
          <option value="">None: each member&apos;s own policy applies</option>
          <option value="accept_matching">Accept what is complete</option>
          <option value="accept_all">Accept everything</option>
          <option value="hold">Hold for review</option>
        </select>
        <span className="text-muted mt-1 text-xs font-normal">
          A member&apos;s listings follow the most permissive of its own policy and its groups&apos;. A group can loosen a policy, never tighten one.
        </span>
      </label>
      <SubmitButton variant={group === null ? "primary" : "secondary"} size="sm" className="self-start">
        {group === null ? "Create group" : "Save group"}
      </SubmitButton>
    </ActionForm>
  );
}

export function DeleteGroupForm({ groupId }: { groupId: number }) {
  return (
    <ActionForm action={deleteGroupAction} className="flex flex-col gap-3">
      <input type="hidden" name="group_id" value={groupId} />
      <Checkbox name="confirmed" value="yes">
        <CheckboxContent>
          <CheckboxControl>
            <CheckboxIndicator />
          </CheckboxControl>
          <Label>Delete this group</Label>
        </CheckboxContent>
        <Description>
          Listings shared with it stop reaching its members through it; each member that loses a listing is sent a withdrawal.
        </Description>
      </Checkbox>
      <SubmitButton variant="danger" size="sm" className="self-start">
        Delete group
      </SubmitButton>
    </ActionForm>
  );
}
