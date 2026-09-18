import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  decodePublicKey,
  type CopyRepository,
  type ListingCopy,
  type NewPartner,
  type Partner,
  type PartnerRepository,
  type PublishedKey,
  type TrustLevel,
} from "@/federation";

// Supabase-backed implementations of the federation core's repositories.
//
// Both take the client they should use. An administrator's action passes the
// signed-in user's client, so the write happens as that user and row level
// security decides whether it may; the sync engine passes the service-role
// client. The repository code is the same either way — which trust domain a
// call runs in is the caller's decision, made where it is visible.

export class RepositoryError extends Error {}

interface StoredKey {
  key_id: string;
  public_key: string;
  created_at: string;
}

const PARTNER_COLUMNS =
  "id, domain, node_uuid, node_name, keys_json, keys_fetched_at, pinned_key_id, trust_level, acceptance_policy, sync_watermark, last_ok_at, last_attempt_at, consecutive_failures, awaiting_approval, request_sent_at, created_at";

const toStoredKeys = (keys: PublishedKey[]): StoredKey[] =>
  keys.map((key) => ({ key_id: key.keyId, public_key: Buffer.from(key.publicKey).toString("base64"), created_at: key.createdAt }));

const date = (value: string | null) => (value === null ? null : new Date(value));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a row as PostgREST returns it
export function toPartner(row: any): Partner {
  return {
    id: String(row.id),
    domain: row.domain,
    nodeUuid: row.node_uuid,
    nodeName: row.node_name,
    keys: (row.keys_json as StoredKey[]).map((key) => ({ keyId: key.key_id, publicKey: decodePublicKey(key.public_key), createdAt: key.created_at })),
    keysFetchedAt: new Date(row.keys_fetched_at),
    pinnedKeyId: row.pinned_key_id,
    trustLevel: row.trust_level,
    acceptancePolicy: row.acceptance_policy,
    syncWatermark: row.sync_watermark,
    lastOkAt: date(row.last_ok_at),
    lastAttemptAt: date(row.last_attempt_at),
    consecutiveFailures: row.consecutive_failures,
    awaitingApproval: row.awaiting_approval,
    requestSentAt: date(row.request_sent_at),
    createdAt: new Date(row.created_at),
  };
}

export class SupabasePartnerRepository implements PartnerRepository {
  constructor(
    private readonly db: SupabaseClient,
    /** Recorded as `approved_by` when an administrator's action creates a verified partner. */
    private readonly actingUserId: string | null = null,
  ) {}

  private async update(partnerId: string, changes: Record<string, unknown>): Promise<void> {
    const { error, count } = await this.db.from("federation_partners").update(changes, { count: "exact" }).eq("id", partnerId);
    if (error) throw new RepositoryError(error.message);
    // Under RLS a refused update is not an error, it is zero rows.
    if (count === 0) throw new RepositoryError("The partner was not updated: it does not exist, or this account may not change it.");
  }

  async list(): Promise<Partner[]> {
    const { data, error } = await this.db.from("federation_partners").select(PARTNER_COLUMNS).order("domain");
    if (error) throw new RepositoryError(error.message);
    return data.map(toPartner);
  }

  async findById(partnerId: string): Promise<Partner | null> {
    const { data, error } = await this.db.from("federation_partners").select(PARTNER_COLUMNS).eq("id", partnerId).maybeSingle();
    if (error) throw new RepositoryError(error.message);
    return data === null ? null : toPartner(data);
  }

  async findByDomain(domain: string): Promise<Partner | null> {
    const { data, error } = await this.db.from("federation_partners").select(PARTNER_COLUMNS).eq("domain", domain).maybeSingle();
    if (error) throw new RepositoryError(error.message);
    return data === null ? null : toPartner(data);
  }

  async create(partner: NewPartner): Promise<Partner> {
    const { data, error } = await this.db
      .from("federation_partners")
      .insert({
        domain: partner.domain,
        node_uuid: partner.nodeUuid,
        node_name: partner.nodeName,
        keys_json: toStoredKeys(partner.keys),
        pinned_key_id: partner.pinnedKeyId,
        trust_level: partner.trustLevel,
        approved_by: partner.trustLevel === "verified" ? this.actingUserId : null,
        acceptance_policy: partner.acceptancePolicy,
      })
      .select(PARTNER_COLUMNS)
      .single();
    if (error) throw new RepositoryError(error.message);
    return toPartner(data);
  }

  updateDiscovery(partnerId: string, discovery: { nodeName: string; keys: PublishedKey[] }) {
    return this.update(partnerId, {
      node_name: discovery.nodeName,
      keys_json: toStoredKeys(discovery.keys),
      keys_fetched_at: new Date().toISOString(),
    });
  }

  setPinnedKey(partnerId: string, keyId: string | null) {
    return this.update(partnerId, { pinned_key_id: keyId });
  }

  setTrustLevel(partnerId: string, trustLevel: TrustLevel) {
    return this.update(partnerId, { trust_level: trustLevel, approved_by: trustLevel === "verified" ? this.actingUserId : null });
  }

  setAcceptancePolicy(partnerId: string, policy: Partner["acceptancePolicy"]) {
    return this.update(partnerId, { acceptance_policy: policy });
  }

  recordUuidChange(partnerId: string, newUuid: string) {
    return this.update(partnerId, { node_uuid: newUuid, trust_level: "provisional", approved_by: null });
  }

  markRequestSent(partnerId: string, at: Date) {
    return this.update(partnerId, { request_sent_at: at.toISOString() });
  }

  recordSyncSuccess(partnerId: string, result: { at: Date; watermark: string | null }) {
    return this.update(partnerId, {
      last_ok_at: result.at.toISOString(),
      last_attempt_at: result.at.toISOString(),
      sync_watermark: result.watermark,
      consecutive_failures: 0,
      awaiting_approval: false,
    });
  }

  recordAwaitingApproval(partnerId: string, at: Date) {
    return this.update(partnerId, { last_attempt_at: at.toISOString(), awaiting_approval: true });
  }

  async recordSyncFailure(partnerId: string, at: Date) {
    const partner = await this.findById(partnerId);
    if (partner === null) return;
    await this.update(partnerId, { last_attempt_at: at.toISOString(), consecutive_failures: partner.consecutiveFailures + 1 });
  }

  /** FP-13: marks a partner record that exists because the partner contacted this node. */
  markFirstContact(partnerId: string, at: Date) {
    return this.update(partnerId, { first_contact_at: at.toISOString() });
  }

  /** Stores a partnership request on the partner row, where the approving administrator sees it. */
  recordPartnerRequest(partnerId: string, request: { message: string | null; contactEmail: string | null }, at: Date) {
    return this.update(partnerId, { request_message: request.message, request_contact_email: request.contactEmail, requested_at: at.toISOString() });
  }

  async countCopies(partnerId: string): Promise<number> {
    const { count, error } = await this.db.from("listing_copies").select("canonical_uri", { count: "exact", head: true }).eq("partner_id", partnerId);
    if (error) throw new RepositoryError(error.message);
    return count ?? 0;
  }

  async delete(partnerId: string): Promise<void> {
    const { error, count } = await this.db.from("federation_partners").delete({ count: "exact" }).eq("id", partnerId);
    if (error) throw new RepositoryError(error.message);
    if (count === 0) throw new RepositoryError("The partner was not removed: it does not exist, or this account may not remove it.");
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a row as PostgREST returns it
export function toCopy(row: any): ListingCopy {
  return {
    canonicalUri: row.canonical_uri,
    partnerId: String(row.partner_id),
    type: row.listing_type,
    status: row.status,
    updatedAt: row.listing_updated_at,
    payload: row.payload,
    provenance: row.provenance,
    tombstonedAt: row.tombstoned_at,
    displayState: row.display_state,
    heldReasons: row.held_reasons,
    hardIdentifiers: row.hard_identifiers,
    inConflict: row.in_conflict,
    unknownSlugs: row.unknown_slugs,
  };
}

export class SupabaseCopyRepository implements CopyRepository {
  constructor(private readonly db: SupabaseClient) {}

  async find(canonicalUri: string): Promise<ListingCopy | null> {
    const { data, error } = await this.db.from("listing_copies").select("*").eq("canonical_uri", canonicalUri).maybeSingle();
    if (error) throw new RepositoryError(error.message);
    return data === null ? null : toCopy(data);
  }

  async upsert(copy: ListingCopy): Promise<void> {
    const { error } = await this.db.from("listing_copies").upsert(
      {
        canonical_uri: copy.canonicalUri,
        partner_id: copy.partnerId,
        listing_type: copy.type,
        status: copy.status,
        listing_updated_at: copy.updatedAt,
        payload: copy.payload,
        provenance: copy.provenance,
        tombstoned_at: copy.tombstonedAt,
        display_state: copy.displayState,
        held_reasons: copy.heldReasons,
        hard_identifiers: copy.hardIdentifiers,
        in_conflict: copy.inConflict,
        unknown_slugs: copy.unknownSlugs,
        last_received_at: new Date().toISOString(),
      },
      { onConflict: "canonical_uri" },
    );
    if (error) throw new RepositoryError(error.message);
  }

  async findLiveByHardIdentifiers(identifiers: string[]): Promise<ListingCopy[]> {
    const { data, error } = await this.db.from("listing_copies").select("*").is("tombstoned_at", null).overlaps("hard_identifiers", identifiers);
    if (error) throw new RepositoryError(error.message);
    return data.map(toCopy);
  }

  async setConflict(canonicalUris: string[], inConflict: boolean): Promise<void> {
    const { error } = await this.db.from("listing_copies").update({ in_conflict: inConflict }).in("canonical_uri", canonicalUris);
    if (error) throw new RepositoryError(error.message);
  }

  async listLiveByPartner(partnerId: string): Promise<ListingCopy[]> {
    const { data, error } = await this.db.from("listing_copies").select("*").eq("partner_id", partnerId).is("tombstoned_at", null);
    if (error) throw new RepositoryError(error.message);
    return data.map(toCopy);
  }

  async setDisplay(canonicalUri: string, decision: { displayState: ListingCopy["displayState"]; heldReasons: string[] }): Promise<void> {
    const { error } = await this.db
      .from("listing_copies")
      .update({ display_state: decision.displayState, held_reasons: decision.heldReasons })
      .eq("canonical_uri", canonicalUri);
    if (error) throw new RepositoryError(error.message);
  }
}
