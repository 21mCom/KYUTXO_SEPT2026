import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Activity, RefreshCw, X } from "lucide-react";
import {
  type BehaviorLabel,
  type BehaviorTallyCounts,
  BEHAVIOR_LABEL_DISPLAY,
} from "@/lib/behavior-profile";

// Display order for the picker: most useful behaviors first, "Not Synced" last
// so the includable/excludable not-synced state is always reachable.
const BEHAVIOR_FILTER_ORDER: BehaviorLabel[] = [
  "dormant",
  "active",
  "high-activity",
  "accumulator",
  "distributor",
  "consolidator",
  "fragmented",
  "used",
  "not-enough-data",
];

interface BehaviorFilterProps {
  selected: Set<BehaviorLabel>;
  onChange: (next: Set<BehaviorLabel>) => void;
  /** Vault-wide count per behavior label, shown beside each option. */
  counts?: BehaviorTallyCounts | null;
  /** True while the vault-wide tally is still being computed. */
  countsComputing?: boolean;
  /** Coarse scan progress for the in-flight tally; null when idle. */
  countsProgress?: { processed: number; total: number | null } | null;
  /** Abort the in-flight tally. */
  onCancelCounts?: () => void;
  /**
   * Re-trigger a fresh recount, e.g. after the user cancelled a previous pass.
   * When provided, a "Recount" button is shown whenever nothing is currently
   * computing.
   */
  onRestartCounts?: () => void;
}

export function BehaviorFilter({
  selected,
  onChange,
  counts,
  countsComputing,
  countsProgress,
  onCancelCounts,
  onRestartCounts,
}: BehaviorFilterProps) {
  const toggle = (label: BehaviorLabel) => {
    const next = new Set(selected);
    if (next.has(label)) {
      next.delete(label);
    } else {
      next.add(label);
    }
    onChange(next);
  };

  const clearAll = () => onChange(new Set());

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              data-testid="button-toggle-behavior-filter"
            >
              <Activity className="h-4 w-4 mr-1" />
              Behavior
              {selected.size > 0 && (
                <Badge variant="secondary" className="ml-2">
                  {selected.size}
                </Badge>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-2" align="start">
            <div className="flex items-center justify-between gap-2 px-2 pb-1">
              <span className="text-xs font-medium text-muted-foreground">
                Across all addresses
              </span>
              {countsComputing ? (
                <div className="flex items-center gap-1.5">
                  <span
                    className="text-xs text-muted-foreground tabular-nums"
                    data-testid="text-behavior-counts-computing"
                  >
                    {countsProgress && countsProgress.total != null
                      ? `Counting ${countsProgress.processed.toLocaleString()} / ${countsProgress.total.toLocaleString()}`
                      : "Counting…"}
                  </span>
                  {onCancelCounts && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={onCancelCounts}
                      data-testid="button-cancel-behavior-counts"
                    >
                      Stop
                    </Button>
                  )}
                </div>
              ) : onRestartCounts && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onRestartCounts}
                  data-testid="button-restart-behavior-counts"
                >
                  <RefreshCw className="h-3 w-3 mr-1" />
                  Recount
                </Button>
              )}
            </div>
            <div className="space-y-1">
              {BEHAVIOR_FILTER_ORDER.map((label) => (
                <label
                  key={label}
                  className="flex items-center gap-2 rounded-md p-2 hover-elevate cursor-pointer"
                  data-testid={`option-behavior-${label}`}
                >
                  <Checkbox
                    checked={selected.has(label)}
                    onCheckedChange={() => toggle(label)}
                    data-testid={`checkbox-behavior-${label}`}
                  />
                  <span className="text-sm">{BEHAVIOR_LABEL_DISPLAY[label]}</span>
                  <span
                    className="ml-auto text-xs tabular-nums text-muted-foreground"
                    data-testid={`count-behavior-${label}`}
                  >
                    {counts
                      ? (counts[label] ?? 0).toLocaleString()
                      : countsComputing
                        ? "…"
                        : ""}
                  </span>
                </label>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        {selected.size > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearAll}
            data-testid="button-clear-behavior-filter"
          >
            Clear
          </Button>
        )}
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap gap-1">
          {Array.from(selected).map((label) => (
            <Badge
              key={label}
              variant="secondary"
              className="text-xs cursor-pointer"
              onClick={() => toggle(label)}
              data-testid={`chip-behavior-${label}`}
            >
              {BEHAVIOR_LABEL_DISPLAY[label]}
              <X className="h-3 w-3 ml-1" />
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
