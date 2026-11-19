import Form from "next/form";
import Link from "next/link";
import { indexHref, PAGE_SIZE, type IndexQuery, type IndexView } from "@/lib/listings/index-query";

// The controls shared by the two listing index pages. Everything is a link or
// a GET form, so the filtered page is a URL: it can be bookmarked, shared and
// reloaded, and the query runs on the server under the reader's RLS.

const nativeField = "border-border bg-field text-foreground mt-1 block w-full rounded-xl border px-3 py-2 text-sm font-normal shadow-sm";

export const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  active: "Active",
  under_offer: "Under offer",
  sold: "Sold",
  withdrawn: "Withdrawn",
};

export function IndexTabs({
  path,
  query,
  views,
  counts,
}: {
  path: string;
  query: IndexQuery;
  views: readonly IndexView[];
  /** Per tab, under the current filters other than status. */
  counts: Record<string, number>;
}) {
  return (
    <nav aria-label="Lifecycle" className="border-border flex gap-6 border-b text-sm">
      {views.map((view) => {
        const current = view.key === query.view;
        return (
          <Link
            key={view.key}
            href={indexHref(path, query, { view: view.key, status: null })}
            aria-current={current ? "page" : undefined}
            className={current ? "border-accent -mb-px border-b-2 pb-2 font-semibold" : "text-muted hover:text-foreground pb-2"}
          >
            {view.label} <span className="text-muted font-normal">{counts[view.key] ?? 0}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export function IndexFilters({
  path,
  query,
  view,
  partners,
  searchable = true,
}: {
  path: string;
  query: IndexQuery;
  view: IndexView;
  /** Offered only on partner listings. */
  partners?: { id: string; label: string }[];
  /** False where the rows hold nothing to search. */
  searchable?: boolean;
}) {
  const filtered = query.type !== null || query.status !== null || query.partner !== null || query.q !== "";
  return (
    <Form action={path} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="view" value={query.view} />
      {searchable && (
        <label className="min-w-56 flex-1 text-sm font-medium">
          Search
          <input type="search" name="q" defaultValue={query.q} placeholder="Name, builder or model" maxLength={100} className={nativeField} />
        </label>
      )}
      <label className="text-sm font-medium">
        Type
        <select name="type" defaultValue={query.type ?? ""} className={nativeField}>
          <option value="">Sale and charter</option>
          <option value="sale">Sale</option>
          <option value="charter">Charter</option>
        </select>
      </label>
      {view.statuses.length > 1 && (
        <label className="text-sm font-medium">
          Status
          <select name="status" defaultValue={query.status ?? ""} className={nativeField}>
            <option value="">Any</option>
            {view.statuses.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABEL[status] ?? status}
              </option>
            ))}
          </select>
        </label>
      )}
      {partners !== undefined && (
        <label className="text-sm font-medium">
          Partner
          <select name="partner" defaultValue={query.partner ?? ""} className={nativeField}>
            <option value="">Every partner</option>
            {partners.map((partner) => (
              <option key={partner.id} value={partner.id}>
                {partner.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <button type="submit" className="bg-accent text-accent-foreground rounded-full px-4 py-2 text-sm font-medium">
        Filter
      </button>
      {filtered && (
        <Link
          href={indexHref(path, query, { type: null, status: null, partner: null, q: "" })}
          className="py-2 text-sm underline-offset-4 hover:underline"
        >
          Clear
        </Link>
      )}
    </Form>
  );
}

export function IndexPagination({ path, query, total }: { path: string; query: IndexQuery; total: number }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages === 1) return null;
  const first = (query.page - 1) * PAGE_SIZE + 1;
  const last = Math.min(query.page * PAGE_SIZE, total);
  return (
    <nav aria-label="Pages" className="flex items-center justify-between text-sm">
      <span className="text-muted">
        {first}–{last} of {total}
      </span>
      <span className="flex gap-4">
        {query.page > 1 && (
          <Link href={indexHref(path, query, { page: query.page - 1 })} className="underline-offset-4 hover:underline">
            ← Newer
          </Link>
        )}
        {query.page < pages && (
          <Link href={indexHref(path, query, { page: query.page + 1 })} className="underline-offset-4 hover:underline">
            Older →
          </Link>
        )}
      </span>
    </nav>
  );
}
