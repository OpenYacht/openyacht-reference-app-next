"use client";

import { Alert, AlertContent, AlertDescription, Input, Label, TextField } from "@heroui/react";
import { useRouter } from "next/navigation";
import { useId, useState, type ChangeEvent } from "react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { addLinkAction, describeMediaAction, finishUploadAction, moveMediaAction, removeMediaAction, startUploadAction } from "./media-actions";

// Mirrors MAX_UPLOAD_BYTES, which the server and the bucket both enforce: this
// copy only saves somebody the wait before being told.
const MAX_UPLOAD_MB = 25;
const CATEGORIES = ["exterior", "interior", "lifestyle", "crew"] as const;
const nativeField = "border-border bg-field text-foreground w-full rounded-xl border px-3 py-2 text-sm shadow-sm";

export interface MediaItemView {
  id: string;
  /** What to show for it: the thumbnail of an image, nothing for a link or a document. */
  thumbnailUrl: string | null;
  /** Where it leads: the served file, or the page a link points to. */
  href: string;
  title: string;
  caption: string | null;
  category?: string | null;
}

export interface MediaView {
  profile: MediaItemView | null;
  gallery: MediaItemView[];
  layouts: MediaItemView[];
  videos: MediaItemView[];
  tours: MediaItemView[];
  documents: MediaItemView[];
}

type Note = { ok: boolean; text: string };

/**
 * The file goes from the browser to Storage, not through this server: see
 * media-actions.ts. One file at a time, so a gallery keeps the order the files
 * were chosen in.
 */
function Uploader({
  listingId,
  collection,
  accept,
  label,
  multiple,
}: {
  listingId: number;
  collection: string;
  accept: string;
  label: string;
  multiple?: boolean;
}) {
  const router = useRouter();
  const inputId = useId();
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);

  async function send(file: File): Promise<Note> {
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) return { ok: false, text: `${file.name}: a file can be at most ${MAX_UPLOAD_MB} MB.` };
    const started = await startUploadAction(listingId);
    if (!started.ok) return { ok: false, text: `${file.name}: ${started.message}` };

    const body = new FormData();
    body.append("cacheControl", "3600");
    body.append("", file);
    const stored = await fetch(started.uploadUrl, { method: "PUT", body, headers: { "x-upsert": "false" } }).catch(() => null);
    if (stored === null || !stored.ok) return { ok: false, text: `${file.name}: the upload was refused. Check its type and size.` };

    const finished = await finishUploadAction(listingId, collection, started.itemId);
    return { ok: finished.ok, text: `${file.name}: ${finished.message ?? ""}` };
  }

  async function onChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const files = [...(input.files ?? [])];
    const results: Note[] = [];
    for (const [index, file] of files.entries()) {
      setBusy(`Uploading ${index + 1} of ${files.length}…`);
      results.push(await send(file));
    }
    input.value = "";
    setBusy(null);
    // Successes show as new items; only what went wrong needs saying.
    setNotes(results.filter((note) => !note.ok));
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={inputId} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={inputId}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={busy !== null}
        onChange={onChange}
        className="file:bg-default file:text-default-foreground text-muted text-sm file:mr-3 file:rounded-xl file:border-0 file:px-4 file:py-2 file:text-sm file:font-medium"
      />
      {busy !== null && <p className="text-muted text-sm">{busy}</p>}
      {notes.map((note) => (
        <Alert key={note.text} status="danger">
          <AlertContent>
            <AlertDescription>{note.text}</AlertDescription>
          </AlertContent>
        </Alert>
      ))}
    </div>
  );
}

function Hidden({ listingId, collection, itemId }: { listingId: number; collection: string; itemId?: string }) {
  return (
    <>
      <input type="hidden" name="listing_id" value={listingId} />
      <input type="hidden" name="collection" value={collection} />
      {itemId !== undefined && <input type="hidden" name="item_id" value={itemId} />}
    </>
  );
}

function Item({
  listingId,
  collection,
  item,
  position,
  count,
}: {
  listingId: number;
  collection: string;
  item: MediaItemView;
  position?: number;
  count?: number;
}) {
  return (
    <li className="border-border flex flex-col gap-3 rounded-2xl border p-3 sm:flex-row">
      {item.thumbnailUrl !== null && (
        // The node's own thumbnail, already the right size: nothing for an image optimiser to do.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.thumbnailUrl} alt={item.caption ?? ""} className="bg-default h-28 w-40 shrink-0 rounded-xl object-cover" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <a href={item.href} target="_blank" rel="noreferrer" className="truncate text-sm underline-offset-4 hover:underline">
          {item.title}
        </a>
        <ActionForm action={describeMediaAction} className="flex flex-col gap-2">
          <Hidden listingId={listingId} collection={collection} itemId={item.id} />
          <div className="flex flex-wrap items-end gap-2">
            <TextField name="caption" defaultValue={item.caption ?? ""} className="min-w-48 flex-1">
              <Label>Caption</Label>
              <Input />
            </TextField>
            {collection === "gallery" && (
              <label className="flex flex-col gap-1 text-sm font-medium">
                Category
                <select name="category" defaultValue={item.category ?? ""} className={nativeField}>
                  <option value="">None</option>
                  {CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <SubmitButton variant="secondary">Save</SubmitButton>
          </div>
        </ActionForm>
        <div className="flex flex-wrap gap-2">
          {position !== undefined && count !== undefined && count > 1 && (
            <>
              <ActionForm action={moveMediaAction} className="contents">
                <Hidden listingId={listingId} collection={collection} itemId={item.id} />
                <input type="hidden" name="direction" value="earlier" />
                <SubmitButton variant="tertiary" size="sm" isDisabled={position === 0}>
                  Move earlier
                </SubmitButton>
              </ActionForm>
              <ActionForm action={moveMediaAction} className="contents">
                <Hidden listingId={listingId} collection={collection} itemId={item.id} />
                <input type="hidden" name="direction" value="later" />
                <SubmitButton variant="tertiary" size="sm" isDisabled={position === count - 1}>
                  Move later
                </SubmitButton>
              </ActionForm>
            </>
          )}
          <ActionForm action={removeMediaAction} className="flex flex-col gap-2">
            <Hidden listingId={listingId} collection={collection} itemId={item.id} />
            <SubmitButton variant="danger-soft" size="sm">
              Remove
            </SubmitButton>
          </ActionForm>
        </div>
      </div>
    </li>
  );
}

function Items({ listingId, collection, items }: { listingId: number; collection: string; items: MediaItemView[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-col gap-3">
      {items.map((item, position) => (
        <Item key={item.id} listingId={listingId} collection={collection} item={item} position={position} count={items.length} />
      ))}
    </ul>
  );
}

function LinkForm({ listingId, collection, label }: { listingId: number; collection: string; label: string }) {
  return (
    <ActionForm action={addLinkAction} className="flex flex-col gap-2" resetOnSuccess>
      <Hidden listingId={listingId} collection={collection} />
      <div className="flex flex-wrap items-end gap-2">
        <TextField name="url" type="url" className="min-w-64 flex-1">
          <Label>{label}</Label>
          <Input placeholder="https://" />
        </TextField>
        <TextField name="caption" className="min-w-48 flex-1">
          <Label>Caption</Label>
          <Input />
        </TextField>
        <SubmitButton variant="secondary">Add</SubmitButton>
      </div>
    </ActionForm>
  );
}

const Section = ({ title, help, children }: { title: string; help: string; children: React.ReactNode }) => (
  <section className="border-border flex flex-col gap-3 border-t pt-5 first:border-t-0 first:pt-0">
    <div>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="text-muted text-sm">{help}</p>
    </div>
    {children}
  </section>
);

export function MediaPanel({ listingId, media }: { listingId: number; media: MediaView }) {
  const images = "image/jpeg,image/png,image/webp";
  return (
    <div className="flex flex-col gap-5">
      <Section
        title="Profile image"
        help="The one image that represents this listing everywhere. Chosen here, never guessed from the gallery — and never a placeholder: a listing with no photograph says so."
      >
        {media.profile !== null && (
          <ul>
            <Item listingId={listingId} collection="profile" item={media.profile} />
          </ul>
        )}
        <Uploader
          listingId={listingId}
          collection="profile"
          accept={images}
          label={media.profile === null ? "Choose the profile image" : "Replace it"}
        />
      </Section>

      <Section
        title="Gallery"
        help="JPEG, PNG or WebP, up to 25 MB each. Position data and other metadata are removed from every file before it is served."
      >
        <Items listingId={listingId} collection="gallery" items={media.gallery} />
        {media.profile === null ? (
          <p className="text-muted text-sm">Choose the profile image first.</p>
        ) : (
          <Uploader listingId={listingId} collection="gallery" accept={images} label="Add images" multiple />
        )}
      </Section>

      <Section title="Layouts" help="General arrangement and deck plans, as images. A plan that is a PDF belongs under documents.">
        <Items listingId={listingId} collection="layouts" items={media.layouts} />
        {media.profile !== null && <Uploader listingId={listingId} collection="layouts" accept={images} label="Add plans" multiple />}
      </Section>

      <Section title="Videos" help="Links to where the video is hosted.">
        <Items listingId={listingId} collection="videos" items={media.videos} />
        <LinkForm listingId={listingId} collection="videos" label="Video address" />
      </Section>

      <Section title="Virtual tours" help="Links to where the tour is hosted.">
        <Items listingId={listingId} collection="tours" items={media.tours} />
        <LinkForm listingId={listingId} collection="tours" label="Tour address" />
      </Section>

      <Section title="Documents" help="Brochures and plans as PDF files. Sent only to partners granted documents.">
        <Items listingId={listingId} collection="documents" items={media.documents} />
        <Uploader listingId={listingId} collection="documents" accept="application/pdf" label="Add PDF files" multiple />
      </Section>
    </div>
  );
}
