import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export interface FilterChip {
  /** Stable key, also used to build the chip/clear-button testids. */
  key: string;
  /** Full chip text, e.g. "Wallet: Savings, Cold storage" or "Dust threshold: 2,000 sats". */
  label: string;
  onRemove: () => void;
}

interface FilterChipsProps {
  chips: FilterChip[];
  onClearAll: () => void;
  /** Prefix used to namespace testids per page, e.g. "dusted". Defaults to "filter". */
  testIdPrefix?: string;
  className?: string;
}

/**
 * Shared "active filters" row: one removable chip per active scope/threshold
 * selection plus a single "Clear all filters" action. Renders nothing when
 * there are no active chips, matching the rest of the app's filter UIs
 * (TransactionSearchFilters, UTXOs).
 */
export function FilterChips({ chips, onClearAll, testIdPrefix = "filter", className }: FilterChipsProps) {
  if (chips.length === 0) return null;

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className ?? ""}`} data-testid={`row-active-filters-${testIdPrefix}`}>
      {chips.map((chip) => (
        <Badge
          key={chip.key}
          variant="secondary"
          className="gap-1 pr-1 font-normal"
          data-testid={`chip-${testIdPrefix}-${chip.key}`}
        >
          {chip.label}
          <button
            type="button"
            onClick={chip.onRemove}
            className="ml-1 rounded-full hover:bg-muted-foreground/20 p-0.5"
            data-testid={`button-clear-${testIdPrefix}-${chip.key}`}
            aria-label={`Clear ${chip.label}`}
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs text-muted-foreground"
        onClick={onClearAll}
        data-testid={`button-clear-all-filters-${testIdPrefix}`}
      >
        Clear all filters
      </Button>
    </div>
  );
}
