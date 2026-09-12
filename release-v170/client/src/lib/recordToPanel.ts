import { type Record as DbRecord } from "@/lib/database";

// Panel-facing shape for a record: identical to the persisted DB record except
// `id` is stringified for the UI. Spreading the DB record (see `toPanelRecord`)
// means any NEW field added to the schema automatically flows through to the
// detail panel and the records list without anyone having to re-list it by hand.
export interface PanelRecord extends Omit<DbRecord, "id"> {
  id: string;
}

// Convert a persisted DB record into the panel-facing shape. The spread carries
// every field through automatically; we only normalize the handful of
// always-present display fields (id -> string, plus defaults for the required
// inputString/label/tags/categories so the UI never sees null/undefined there).
export function toPanelRecord(r: DbRecord): PanelRecord {
  return {
    ...r,
    id: String(r.id),
    inputString: r.inputString || "",
    label: r.label || "Unlabeled",
    tags: r.tags || [],
    categories: r.categories || [],
  };
}
