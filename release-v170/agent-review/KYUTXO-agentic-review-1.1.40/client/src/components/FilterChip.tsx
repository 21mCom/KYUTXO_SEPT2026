import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface FilterChipProps {
  /** Text shown inside the chip, e.g. "Owner: Alice" or `"search text"`. */
  label: string;
  /** Called when the user clicks the chip's remove button. */
  onRemove: () => void;
  testId?: string;
}

/**
 * A single removable active-filter chip. Shared across the app's secondary
 * list pages (ConflictResolution, AddressReuse, VaultManagement, Evidence,
 * BulkEditor) so "which filters are active right now" always looks the same.
 */
export function FilterChip({ label, onRemove, testId }: FilterChipProps) {
  return (
    <Badge variant="secondary" className="gap-1 pr-1 font-normal" data-testid={testId}>
      <span className="max-w-[220px] truncate">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        className="ml-0.5 rounded-full hover:bg-muted-foreground/20 p-0.5"
        aria-label={`Remove filter: ${label}`}
        data-testid={testId ? `${testId}-remove` : undefined}
      >
        <X className="h-3 w-3" />
      </button>
    </Badge>
  );
}
