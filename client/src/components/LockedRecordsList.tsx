import { Button } from "@/components/ui/button";
import { ExternalLink } from "lucide-react";
import { useAdaptiveLocation } from "@/lib/hashLocation";
import type { LockedRecordRef } from "@/lib/legacy-decrypt";

// Only the "Records" table has a navigable detail view (the Records page reads
// `?id=` and opens the matching record). Every other legacy table (Tags,
// Owners, Evidence, …) has no per-row deep link, so those ids are shown as
// plain text — still useful for locating the row, just not clickable.
const NAVIGABLE_TABLE = "Records";

function groupByTable(refs: LockedRecordRef[]): [string, number[]][] {
  return Array.from(
    refs.reduce((map, ref) => {
      const ids = map.get(ref.tableName) ?? [];
      ids.push(ref.id);
      map.set(ref.tableName, ids);
      return map;
    }, new Map<string, number[]>()),
  );
}

interface LockedRecordsListProps {
  lockedRecords: LockedRecordRef[];
  truncated?: boolean;
  /**
   * Runs immediately before navigating to a record (e.g. to dismiss an overlay
   * that would otherwise cover the page we are sending the user to).
   */
  beforeNavigate?: () => void;
}

/**
 * Renders the still-locked rows grouped by table. For the Records table each id
 * becomes a button that jumps straight to that record (via the offline
 * `/records?id=` deep link) so the user can confirm it unlocked after recovery.
 */
export function LockedRecordsList({
  lockedRecords,
  truncated,
  beforeNavigate,
}: LockedRecordsListProps) {
  const [, setLocation] = useAdaptiveLocation();

  const grouped = groupByTable(lockedRecords);

  const openRecord = (id: number) => {
    beforeNavigate?.();
    setLocation(`/records?id=${id}`);
  };

  return (
    <div
      className="max-h-48 overflow-y-auto rounded-md border border-border bg-background p-3 text-left"
      data-testid="list-locked-records"
    >
      <div className="space-y-2">
        {grouped.map(([tableName, ids]) => {
          const navigable = tableName === NAVIGABLE_TABLE;
          return (
            <div key={tableName} data-testid={`group-locked-${tableName}`}>
              <p className="text-xs font-medium text-foreground">
                {tableName} ({ids.length})
              </p>
              {navigable ? (
                <div className="flex flex-wrap gap-1 pt-1">
                  {ids.map((id) => (
                    <Button
                      key={id}
                      size="sm"
                      variant="outline"
                      onClick={() => openRecord(id)}
                      data-testid={`button-open-locked-record-${id}`}
                    >
                      <ExternalLink className="h-3 w-3" />#{id}
                    </Button>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground break-words">
                  {ids.map((id) => `#${id}`).join(", ")}
                </p>
              )}
            </div>
          );
        })}
      </div>
      {truncated && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="text-locked-truncated">
          Showing the first {lockedRecords.length} locked records — more remain.
          Recover them all to clear the rest.
        </p>
      )}
    </div>
  );
}
