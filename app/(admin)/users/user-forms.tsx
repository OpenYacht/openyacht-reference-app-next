"use client";

import { Checkbox, CheckboxContent, CheckboxControl, CheckboxIndicator, Description, FieldError, Input, Label, TextField } from "@heroui/react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { deleteUserAction, inviteUserAction, passwordLinkAction, setRoleAction } from "./actions";

export interface RoleOption {
  name: string;
  description: string;
}

const nativeField = "border-border bg-field text-foreground mt-1 w-full rounded-xl border px-3 py-2 text-sm shadow-sm";

function RoleSelect({ roles, defaultValue, allowNone }: { roles: RoleOption[]; defaultValue: string; allowNone: boolean }) {
  return (
    <label className="flex flex-col text-sm font-medium">
      Role
      <select name="role" defaultValue={defaultValue} className={nativeField}>
        {allowNone && <option value="">No role (no access)</option>}
        {roles.map((role) => (
          <option key={role.name} value={role.name}>
            {role.name}: {role.description}
          </option>
        ))}
      </select>
    </label>
  );
}

export function InviteUserForm({ roles }: { roles: RoleOption[] }) {
  return (
    <ActionForm action={inviteUserAction} className="flex flex-col gap-4" resetOnSuccess>
      <TextField name="email" type="email" isRequired autoComplete="off">
        <Label>Email</Label>
        <Input />
        <Description>No email is sent. You get a one-time link to pass on, and they choose their own password.</Description>
        <FieldError />
      </TextField>
      <RoleSelect roles={roles} defaultValue={roles.at(-1)?.name ?? ""} allowNone={false} />
      <SubmitButton variant="primary" className="self-start">
        Create account
      </SubmitButton>
    </ActionForm>
  );
}

export function ManageUser({ userId, role, roles }: { userId: string; role: string | null; roles: RoleOption[] }) {
  // A role the administrator cannot give (their own rank, say) is not in the
  // list, so the select would silently show something else. Changing is then
  // not offered; removing still is, through "No role".
  const current = role !== null && roles.some((option) => option.name === role) ? role : "";
  return (
    <div className="flex flex-col gap-5 py-3">
      <ActionForm action={setRoleAction} className="flex flex-col gap-3">
        <input type="hidden" name="user_id" value={userId} />
        <RoleSelect roles={roles} defaultValue={current} allowNone />
        <SubmitButton variant="secondary" size="sm" className="self-start">
          Save role
        </SubmitButton>
      </ActionForm>

      <ActionForm action={passwordLinkAction} className="flex flex-col gap-3">
        <input type="hidden" name="user_id" value={userId} />
        <SubmitButton variant="secondary" size="sm" className="self-start">
          Make a password link
        </SubmitButton>
      </ActionForm>

      <ActionForm action={deleteUserAction} className="flex flex-col gap-3">
        <input type="hidden" name="user_id" value={userId} />
        <Checkbox name="confirmed" value="yes">
          <CheckboxContent>
            <CheckboxControl>
              <CheckboxIndicator />
            </CheckboxControl>
            <Label>Delete this account</Label>
          </CheckboxContent>
          <Description>Their listings stay, unassigned. The record of their role changes stays too.</Description>
        </Checkbox>
        <SubmitButton variant="danger" size="sm" className="self-start">
          Delete account
        </SubmitButton>
      </ActionForm>
    </div>
  );
}
