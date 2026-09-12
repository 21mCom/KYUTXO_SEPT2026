import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { CalendarPlus, ArrowDown, ArrowUp, X } from "lucide-react";

// 'default' = control untouched (legacy id ordering + engine fast path stays
// on). Explicit 'newest'/'oldest' both route through true createdAt ordering.
export type DateAddedSort = "default" | "newest" | "oldest";

export type RecencyPreset = "any" | "24h" | "7d" | "30d" | "custom";

const PRESET_LABELS: { id: Exclude<RecencyPreset, "custom">; label: string }[] = [
  { id: "any", label: "Any time" },
  { id: "24h", label: "Last 24h" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
];

const PRESET_MS: Record<"24h" | "7d" | "30d", number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export interface DateAddedFilterProps {
  sort: DateAddedSort;
  onSortChange: (sort: DateAddedSort) => void;
  /** Inclusive "added since" threshold in ms, or null for no recency window. */
  since: number | null;
  onSinceChange: (since: number | null) => void;
}

/**
 * "Date Added" controls for the Records filter bar: a newest/oldest sort
 * toggle plus a "Recently added" quick filter (preset windows + custom
 * since-date). Composes with the existing column filters and search — the
 * page routes any active date-added query to the createdAt keyset path.
 */
export function DateAddedFilter({ sort, onSortChange, since, onSinceChange }: DateAddedFilterProps) {
  const [preset, setPreset] = useState<RecencyPreset>("any");
  const [customDate, setCustomDate] = useState("");

  const active = sort !== "default" || since !== null;

  const applyPreset = (id: Exclude<RecencyPreset, "custom">) => {
    setPreset(id);
    setCustomDate("");
    onSinceChange(id === "any" ? null : Date.now() - PRESET_MS[id]);
  };

  const applyCustomDate = (value: string) => {
    setCustomDate(value);
    if (!value) {
      setPreset("any");
      onSinceChange(null);
      return;
    }
    const ts = new Date(`${value}T00:00:00`).getTime();
    if (Number.isFinite(ts)) {
      setPreset("custom");
      onSinceChange(ts);
    }
  };

  const reset = () => {
    setPreset("any");
    setCustomDate("");
    onSinceChange(null);
    onSortChange("default");
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-sm font-medium flex items-center gap-1 text-muted-foreground">
        <CalendarPlus className="h-4 w-4" />
        Date Added
      </span>

      <Button
        variant="outline"
        size="sm"
        onClick={() => onSortChange(sort === "oldest" ? "newest" : "oldest")}
        data-testid="button-date-added-sort"
      >
        {sort === "oldest" ? (
          <ArrowUp className="h-4 w-4 mr-1" />
        ) : (
          <ArrowDown className="h-4 w-4 mr-1" />
        )}
        {sort === "oldest" ? "Oldest first" : "Newest first"}
      </Button>

      <div className="flex items-center gap-1">
        {PRESET_LABELS.map(({ id, label }) => (
          <Button
            key={id}
            variant={preset === id ? "secondary" : "ghost"}
            size="sm"
            onClick={() => applyPreset(id)}
            data-testid={`button-added-preset-${id}`}
          >
            {label}
          </Button>
        ))}
        <Input
          type="date"
          value={customDate}
          onChange={(e) => applyCustomDate(e.target.value)}
          className="w-[150px] h-8"
          aria-label="Added since date"
          data-testid="input-added-since-date"
        />
      </div>

      {active && (
        <>
          <Badge variant="secondary" data-testid="badge-date-added-active">
            {sort === "oldest" ? "Oldest first" : "Newest first"}
            {since !== null ? " · recently added" : ""}
          </Badge>
          <Button
            variant="ghost"
            size="sm"
            onClick={reset}
            data-testid="button-date-added-reset"
          >
            <X className="h-4 w-4 mr-1" />
            Reset
          </Button>
        </>
      )}
    </div>
  );
}
