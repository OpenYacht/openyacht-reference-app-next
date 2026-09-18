import "server-only";
import type { OwnPublishedKey } from "@/federation";
import { toWireTimestamp } from "@/federation";
import { serviceClient } from "@/lib/supabase/service";

/** What the federation handlers need from storage. Tests substitute an in-memory one. */
export interface NodeState {
  nodeUuid: string | null;
  /** The identity domain recorded when setup completed. */
  identityDomain: string | null;
  setupCompleted: boolean;
}

export interface NodeStore {
  getState(): Promise<NodeState>;
  /** Keys to publish: current signing key first, then any still in rotation overlap. Never revoked keys. */
  listPublishedKeys(): Promise<OwnPublishedKey[]>;
}

export class NodeStoreError extends Error {}

export const supabaseNodeStore: NodeStore = {
  async getState() {
    const { data, error } = await serviceClient().from("node_settings").select("node_uuid, identity_domain, setup_completed_at").single();
    if (error) throw new NodeStoreError(`Cannot read node_settings: ${error.message}. Have the migrations been applied?`);
    return {
      nodeUuid: data.node_uuid,
      identityDomain: data.identity_domain,
      setupCompleted: data.setup_completed_at !== null,
    };
  },

  async listPublishedKeys() {
    const { data, error } = await serviceClient()
      .from("federation_keys")
      .select("key_id, public_key, created_at")
      .in("status", ["active", "retiring"])
      .order("id", { ascending: false });
    if (error) throw new NodeStoreError(`Cannot read federation_keys: ${error.message}`);
    return data.map((row) => ({
      keyId: row.key_id,
      publicKey: row.public_key,
      createdAt: toWireTimestamp(new Date(row.created_at)),
    }));
  },
};
