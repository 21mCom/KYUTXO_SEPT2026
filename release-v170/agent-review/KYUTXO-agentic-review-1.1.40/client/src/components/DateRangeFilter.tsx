import { useState } from "react";
import { X } from "lucide-react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type DateRangeScopeMode = "any" | "range" | "exact";

export interface DateRangeFilterValue {
  mode: DateRangeScopeMode;
  /** yyyy-MM-dd, used when mode === "range" */
  from?: string;
  /** yyyy-MM-dd, used when mode === "range" */
  to?: string;
  /** yyyy-MM-dd, used when mode === "exact" */
  date?: string;
}

/** Default value: no date scoping applied. */
export const ANY_DATE_RANGE_FILTER: DateRangeFilterValue = { mode: "any" };

function parseLocalDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Whether the filter currently narrows results (i.e. isn't "any time"). */
export function isDateRangeFilterActive(value: DateRangeFilterValue): boolean {
  if (value.mode === "exact") return !!value.date;
  if (value.mode === "range") return !!(value.from || value.to);
  return false;
}

/**
 * Converts a filter value into inclusive Unix-SECOND bounds (matching the
 * blockchainTransactions.blockTime convention used across the app), or
 * undefined when the filter isn't scoping anything ("any time").
 */
export function dateRangeFilterToUnixRange(
  value: DateRangeFilterValue,
): { start?: number; end?: number } | undefined {
  if (value.mode === "exact") {
    if (!value.date) return undefined;
    const start = Math.floor(new Date(`${value.date}T00:00:00`).getTime() / 1000);
    const end = Math.floor(new Date(`${value.date}T23:59:59`).getTime() / 1000);
    return { start, end };
  }
  if (value.mode === "range") {
    const start = value.from ? Math.floor(new Date(`${value.from}T00:00:00`).getTime() / 1000) : undefined;
    const end = value.to ? Math.floor(new Date(`${value.to}T23:59:59`).getTime() / 1000) : undefined;
    if (start === undefined && end === undefined) return undefined;
    return { start, end };
  }
  return undefined;
}

function summarize(value: DateRangeFilterValue): string | null {
  if (value.mode === "exact" && value.date) {
    const d = parseLocalDate(value.date);
    return d ? format(d, "MMM d, yyyy") : null;
  }
  if (value.mode === "range" && (value.from || value.to)) {
    const from = parseLocalDate(value.from);
    const to = parseLocalDate(value.to);
    if (from && to) return `${format(from, "MMM d, yyyy")} \u2013 ${format(to, "MMM d, yyyy")}`;
    if (from) return `From ${format(from, "MMM d, yyyy")}`;
    if (to) return `Until ${format(to, "MMM d, yyyy")}`;
  }
  return null;
}

export interface DateRangeFilterProps {
  value: DateRangeFilterValue;
  onChange: (value: DateRangeFilterValue) => void;
  label?: string;
  testId?: string;
  className?: string;
}

/**
 * Shared date-scoping control for report/analysis pages: a "From"/"To" date
 * pair (mode "range") with an "Exact date" toggle that collapses them into a
 * single date field (mode "exact"). Leaving every field blank is mode "any"
 * (no scoping). Emits yyyy-MM-dd strings; use `dateRangeFilterToUnixRange`
 * to convert to inclusive Unix-second bounds for filtering blockchain data.
 */
export function DateRangeFilter({
  value,
  onChange,
  label = "Date Range",
  testId = "date-range-filter",
  className,
}: DateRangeFilterProps) {
  const isExact = value.mode === "exact";
  const active = isDateRangeFilterActive(value);
  const summary = summarize(value);

  const setFrom = (from: string) => {
    onChange({ mode: "range", from: from || undefined, to: value.to });
  };
  const setTo = (to: string) => {
    onChange({ mode: "range", from: value.from, to: to || undefined });
  };
  const setExactDate = (date: string) => {
    onChange({ mode: "exact", date: date || undefined });
  };

  const toggleExact = (checked: boolean) => {
    if (checked) {
      onChange({ mode: "exact", date: value.date ?? value.from });
    } else {
      onChange({ mode: "range", from: value.date, to: undefined });
    }
  };

  const clear = () => {
    onChange({ mode: "any" });
  };

  return (
    <div className={cn("flex flex-col gap-1", className)} data-testid={testId}>
      {label && (
        <span className="text-xs text-muted-foreground font-medium" data-testid={`label-${testId}`}>
          {label}
        </span>
      )}
      <div className="flex flex-wrap items-end gap-2">
        {isExact ? (
          <div className="flex flex-col gap-1">
            <Input
              type="date"
              value={value.date || ""}
              onChange={e => setExactDate(e.target.value)}
              className="h-9 w-40"
              data-testid={`input-${testId}-date`}
            />
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <Input
                type="date"
                value={value.from || ""}
                max={value.to || undefined}
                onChange={e => setFrom(e.target.value)}
                placeholder="From"
                className="h-9 w-40"
                data-testid={`input-${testId}-from`}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Input
                type="date"
                value={value.to || ""}
                min={value.from || undefined}
                onChange={e => setTo(e.target.value)}
                placeholder="To"
                className="h-9 w-40"
                data-testid={`input-${testId}-to`}
              />
            </div>
          </>
        )}

        <label className="flex items-center gap-1.5 text-xs text-muted-foreground pb-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={isExact}
            onChange={e => toggleExact(e.target.checked)}
            data-testid={`checkbox-${testId}-exact`}
            className="h-3.5 w-3.5"
          />
          Exact date
        </label>

        {active && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={clear}
            data-testid={`button-${testId}-clear`}
          >
            <X className="h-3.5 w-3.5 mr-1" />
            Clear
          </Button>
        )}
      </div>
      {summary && (
        <span className="text-xs text-muted-foreground italic" data-testid={`text-${testId}-summary`}>
          {summary}
        </span>
      )}
    </div>
  );
}
