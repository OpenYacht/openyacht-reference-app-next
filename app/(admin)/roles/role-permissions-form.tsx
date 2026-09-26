"use client";

import { Checkbox, CheckboxContent, CheckboxControl, CheckboxIndicator, Description, Label } from "@heroui/react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { setRolePermissionsAction } from "./actions";

export interface PermissionOption {
  name: string;
  description: string;
  /** Held by the editor: only those can be granted or withdrawn by them. */
  movable: boolean;
}

export function RolePermissionsForm({ role, held, options }: { role: string; held: string[]; options: PermissionOption[] }) {
  return (
    <ActionForm action={setRolePermissionsAction} className="flex flex-col gap-3">
      <input type="hidden" name="role" value={role} />
      {options.map((option) => (
        <div key={option.name}>
          {/* A disabled checkbox is not submitted; its current state is, so saving never withdraws what this editor cannot. */}
          {!option.movable && held.includes(option.name) && <input type="hidden" name="permissions" value={option.name} />}
          <Checkbox name="permissions" value={option.name} defaultSelected={held.includes(option.name)} isDisabled={!option.movable}>
            <CheckboxContent>
              <CheckboxControl>
                <CheckboxIndicator />
              </CheckboxControl>
              <Label className="font-mono text-sm">{option.name}</Label>
            </CheckboxContent>
            <Description>{option.description}</Description>
          </Checkbox>
        </div>
      ))}
      <SubmitButton variant="secondary" size="sm" className="self-start">
        Save {role}
      </SubmitButton>
    </ActionForm>
  );
}
