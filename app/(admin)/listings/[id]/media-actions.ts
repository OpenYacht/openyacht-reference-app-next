"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/action-form";
import { requireRole } from "@/lib/auth/session";
import { storedFiles, type StoredDocument, type StoredImage, type StoredMedia } from "@/lib/listings/own-listing-row";
import { MAX_UPLOAD_BYTES, renderImage, sha256Hex, type Rendition } from "@/lib/media/renditions";
import { ORIGINALS_BUCKET, SERVED_BUCKET, UPLOADS_BUCKET } from "@/lib/media/storage";
import { userClient } from "@/lib/supabase/server";

// A file does not pass through this server on its way in. A request body is
// capped by the platform the node runs on, often at a few megabytes, and a
// photograph worth listing is larger than that. So:
//
//   1. startUploadAction    hands the browser a one-time URL into the uploads bucket
//   2. the browser PUTs the file to Storage directly
//   3. finishUploadAction   reads it back, decides what it really is, writes the
//                           files this node will serve, and records them
//
// Everything runs as the signed-in user. Storage policies let whoever may
// change a listing write under its UUID, and nobody else; the media functions
// in the database apply the same rule to the listing itself.

const IMAGE_COLLECTIONS = ["profile", "gallery", "layouts"] as const;
const LINK_COLLECTIONS = ["videos", "tours"] as const;
const COLLECTIONS = [...IMAGE_COLLECTIONS, ...LINK_COLLECTIONS, "documents"] as const;
type Collection = (typeof COLLECTIONS)[number];

const isCollection = (value: unknown): value is Collection => COLLECTIONS.includes(value as Collection);
const isImageCollection = (value: Collection): value is (typeof IMAGE_COLLECTIONS)[number] => IMAGE_COLLECTIONS.includes(value as never);
const failed = (message: string): ActionState => ({ ok: false, message });

/** 128 random bits: the part of a file's path that makes its URL unguessable. */
const newItemId = () => randomBytes(16).toString("hex");
const ITEM_ID = /^[0-9a-f]{32}$/;

async function listingUuid(listingId: number): Promise<string | null> {
  const { data } = await (await userClient()).from("listings").select("uuid").eq("id", listingId).maybeSingle();
  return data?.uuid ?? null;
}

export type StartUploadResult = { ok: true; itemId: string; uploadUrl: string } | { ok: false; message: string };

export async function startUploadAction(listingId: number): Promise<StartUploadResult> {
  await requireRole("broker");
  const uuid = await listingUuid(listingId);
  if (uuid === null) return { ok: false, message: "No such listing." };

  const itemId = newItemId();
  // Storage checks the insert policy for this user and this path before it
  // signs anything: a listing that is not theirs to change ends here.
  const { data, error } = await (await userClient()).storage.from(UPLOADS_BUCKET).createSignedUploadUrl(`${uuid}/${itemId}/upload`);
  if (error) return { ok: false, message: "This listing is not yours to change." };
  return { ok: true, itemId, uploadUrl: data.signedUrl };
}

export async function finishUploadAction(listingId: number, collection: string, itemId: string): Promise<ActionState> {
  await requireRole("broker");
  if (!isCollection(collection) || LINK_COLLECTIONS.includes(collection as never)) return failed("Unknown media collection.");
  if (!ITEM_ID.test(itemId)) return failed("Unknown upload.");
  const uuid = await listingUuid(listingId);
  if (uuid === null) return failed("No such listing.");

  const supabase = await userClient();
  const uploadPath = `${uuid}/${itemId}/upload`;
  const written: { bucket: string; path: string }[] = [];
  const put = async (bucket: string, path: string, bytes: Buffer, contentType: string) => {
    // Cacheable for a year: a path is written once and never reused, so what a URL returns never changes.
    const { error } = await supabase.storage.from(bucket).upload(path, bytes, { contentType, cacheControl: "31536000", upsert: false });
    if (error) throw new Error(`The file could not be stored: ${error.message}`);
    written.push({ bucket, path });
  };

  try {
    const { data: blob, error } = await supabase.storage.from(UPLOADS_BUCKET).download(uploadPath);
    if (error) return failed("The upload did not arrive. Try again.");
    const bytes = Buffer.from(await blob.arrayBuffer());
    if (bytes.byteLength > MAX_UPLOAD_BYTES) return failed(`A file can be at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);

    let item: StoredImage | Omit<StoredDocument, "sort">;
    if (isImageCollection(collection)) {
      const { original, derived, thumbnail } = await renderImage(bytes);
      const path = (name: string) => `${uuid}/${itemId}/${name}.jpg`;
      await put(SERVED_BUCKET, path("derived"), derived.bytes, derived.contentType);
      await put(SERVED_BUCKET, path("thumbnail"), thumbnail.bytes, thumbnail.contentType);
      // Kept only where it says more than the derived rendition does.
      const holdsMore = original.width > derived.width || original.height > derived.height;
      if (holdsMore) await put(ORIGINALS_BUCKET, path("original"), original.bytes, original.contentType);
      const describe = ({ sha256, width, height }: Rendition) => ({ sha256, width, height });
      item = {
        id: itemId,
        path: path("derived"),
        thumbnail_path: path("thumbnail"),
        ...describe(derived),
        original: holdsMore ? { path: path("original"), ...describe(original) } : null,
        caption: null,
        ...(collection === "gallery" ? { category: null } : {}),
      };
    } else {
      // The content type the browser claimed is not evidence; the first bytes are.
      if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return failed("Documents are PDF files. Plans drawn as images belong under layouts.");
      const path = `${uuid}/${itemId}/document.pdf`;
      await put(SERVED_BUCKET, path, bytes, "application/pdf");
      item = { id: itemId, path, sha256: sha256Hex(bytes), caption: null };
    }

    const { data: replaced, error: recordError } = await supabase.rpc("add_listing_media", {
      p_listing_id: listingId,
      p_collection: collection,
      p_item: item,
    });
    if (recordError) throw new Error(recordError.message);
    written.length = 0;
    // A replaced profile image leaves files nothing refers to any more.
    if (replaced !== null) await removeFiles({ profile: replaced as StoredImage });
  } catch (error) {
    // Nothing was recorded, so nothing may be left behind.
    for (const { bucket, path } of written) await supabase.storage.from(bucket).remove([path]);
    if (error instanceof Error) return failed(error.message);
    throw error;
  } finally {
    await supabase.storage.from(UPLOADS_BUCKET).remove([uploadPath]);
  }

  revalidatePath(`/listings/${listingId}`);
  return { ok: true, message: "Added. Partners who can see this listing receive the change on their next poll." };
}

/** Best effort: a file left behind is unreachable clutter, never a wrong answer to a partner. */
async function removeFiles(media: StoredMedia) {
  const supabase = await userClient();
  const { served, originals } = storedFiles(media);
  if (served.length > 0) await supabase.storage.from(SERVED_BUCKET).remove(served);
  if (originals.length > 0) await supabase.storage.from(ORIGINALS_BUCKET).remove(originals);
}

export async function addLinkAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  await requireRole("broker");
  const listingId = Number(form.get("listing_id"));
  const collection = String(form.get("collection"));
  if (!LINK_COLLECTIONS.includes(collection as never)) return failed("Unknown media collection.");

  let url: URL;
  try {
    url = new URL(String(form.get("url") ?? "").trim());
  } catch {
    return failed("Enter the full address of the page, starting with https://");
  }
  if (url.protocol !== "https:") return failed("Links must be https:// addresses.");

  const caption = String(form.get("caption") ?? "").trim();
  const { error } = await (
    await userClient()
  ).rpc("add_listing_media", {
    p_listing_id: listingId,
    p_collection: collection,
    p_item: { id: newItemId(), url: url.toString(), caption: caption === "" ? null : caption },
  });
  if (error) return failed(error.message);
  revalidatePath(`/listings/${listingId}`);
  return { ok: true, message: "Added." };
}

export async function removeMediaAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  await requireRole("broker");
  const listingId = Number(form.get("listing_id"));
  const collection = String(form.get("collection"));
  if (!isCollection(collection)) return failed("Unknown media collection.");

  const { data: removed, error } = await (
    await userClient()
  ).rpc("remove_listing_media", { p_listing_id: listingId, p_collection: collection, p_item_id: String(form.get("item_id")) });
  if (error) return failed(error.message);
  if (removed !== null && collection !== "videos" && collection !== "tours") {
    await removeFiles(collection === "documents" ? { documents: [removed as StoredDocument] } : { profile: removed as StoredImage });
  }
  revalidatePath(`/listings/${listingId}`);
  return { ok: true, message: "Removed." };
}

export async function describeMediaAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  await requireRole("broker");
  const listingId = Number(form.get("listing_id"));
  const category = String(form.get("category") ?? "");
  const { error } = await (
    await userClient()
  ).rpc("describe_listing_media", {
    p_listing_id: listingId,
    p_collection: String(form.get("collection")),
    p_item_id: String(form.get("item_id")),
    p_caption: String(form.get("caption") ?? ""),
    p_category: category === "" ? null : category,
  });
  if (error) return failed(error.message);
  revalidatePath(`/listings/${listingId}`);
  return { ok: true, message: "Saved." };
}

export async function moveMediaAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  await requireRole("broker");
  const listingId = Number(form.get("listing_id"));
  const { error } = await (
    await userClient()
  ).rpc("move_listing_media", {
    p_listing_id: listingId,
    p_collection: String(form.get("collection")),
    p_item_id: String(form.get("item_id")),
    p_direction: form.get("direction") === "earlier" ? -1 : 1,
  });
  if (error) return failed(error.message);
  revalidatePath(`/listings/${listingId}`);
  return { ok: true, message: "Moved." };
}
