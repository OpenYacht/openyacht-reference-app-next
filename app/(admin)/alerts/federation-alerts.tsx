"use client";

import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { dismissAlertAction } from "./actions";

export interface FederationAlert {
  id: number;
  kind: "first_contact" | "node_uuid_changed";
  partner_id: number | null;
  domain: string;
  node_name: string | null;
  raised_at: string;
}

const MESSAGE = {
  // FP-13
  first_contact: "made first contact. It is registered as provisional: nothing is shared with it until someone approves it.",
  // FP-11
  node_uuid_changed:
    "now answers with a different node UUID: a different installation may be behind that domain. The partner is back to provisional until someone approves it again.",
} as const;

export function FederationAlerts({ alerts, linkPartners }: { alerts: FederationAlert[]; linkPartners: boolean }) {
  return (
    <ul className="flex flex-col gap-4">
      {alerts.map((alert) => (
        <li key={alert.id} className="flex flex-wrap items-start justify-between gap-3 text-sm">
          <p className="max-w-prose">
            <span className="text-muted">{new Date(alert.raised_at).toISOString().slice(0, 16).replace("T", " ")} UTC</span>{" "}
            <strong>{alert.node_name ?? alert.domain}</strong> <span className="font-mono">({alert.domain})</span> {MESSAGE[alert.kind]}{" "}
            {linkPartners && alert.partner_id !== null && (
              <Link href={`/partners/${alert.partner_id}`} className="underline underline-offset-4">
                Review the partner
              </Link>
            )}
          </p>
          <ActionForm action={dismissAlertAction} className="flex">
            <input type="hidden" name="alert_id" value={alert.id} />
            <SubmitButton variant="secondary" size="sm">
              Dismiss
            </SubmitButton>
          </ActionForm>
        </li>
      ))}
    </ul>
  );
}
