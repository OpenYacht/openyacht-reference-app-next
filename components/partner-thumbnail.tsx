import type { Thumbnail } from "@/lib/listings/wire-thumbnails";

/**
 * An authority-served thumbnail, loaded by the reader's browser from the
 * partner's host. A plain <img>, not next/image: the image optimiser would
 * turn this node into an open fetcher of whatever hosts partners name. No
 * referrer is sent, so the partner's host never learns this node's admin URLs.
 */
export function PartnerThumbnail({ thumbnail, alt, className }: { thumbnail: Thumbnail; alt: string; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- see above
    <img
      src={thumbnail.src}
      alt={thumbnail.caption ?? alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className={`bg-surface-secondary object-cover ${className ?? ""}`}
    />
  );
}
