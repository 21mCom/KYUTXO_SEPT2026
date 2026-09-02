import { useState } from "react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import { 
  CalendarIcon, 
  Search, 
  X, 
  Filter,
  CalendarDays,
  Coins,
  Link as LinkIcon
} from "lucide-react";
import { SiBitcoin } from "react-icons/si";
import { cn } from "@/lib/utils";

const SATS_PER_BTC = 100_000_000;

/** Display unit for the amount-range filter; storage stays canonical BTC. */
export type AmountDisplayUnit = "btc" | "sats";

function btcToDisplay(btc: number | undefined, unit: AmountDisplayUnit): number | undefined {
  if (btc === undefined) return undefined;
  return unit === "sats" ? Math.round(btc * SATS_PER_BTC) : btc;
}

function displayToBtc(value: number | undefined, unit: AmountDisplayUnit): number | undefined {
  if (value === undefined) return undefined;
  return unit === "sats" ? value / SATS_PER_BTC : value;
}

function formatDisplayAmount(btc: number, unit: AmountDisplayUnit): string {
  return unit === "sats"
    ? `${Math.round(btc * SATS_PER_BTC).toLocaleString()} sats`
    : `${btc} BTC`;
}

export interface SearchFilters {
  dateMode: "any" | "range" | "exact";
  dateStart?: Date;
  dateEnd?: Date;
  dateExact?: Date;
  amountMode: "any" | "range" | "exact";
  amountMinBtc?: number;
  amountMaxBtc?: number;
  amountExactBtc?: number;
  // Entity filters — each dimension restricts to transactions with a
  // participant matching ANY of the selected values (see TxEntityFilter).
  entityAddress?: string;
  entityWallet?: string[];
  entitySeed?: string[];
  entityOwner?: string[];
  entityTag?: string[];
  entityCategory?: string[];
}

/** Dropdown value pools for the entity selects, sourced from vocabulary. */
export interface EntityFilterOptions {
  wallets: string[];
  seeds: string[];
  owners: string[];
  tags: string[];
  categories: string[];
}

interface TransactionSearchFiltersProps {
  filters: SearchFilters;
  onChange: (filters: SearchFilters) => void;
  onClear: () => void;
  entityOptions?: EntityFilterOptions;
  /** Whether to show the linked-entity controls inside Advanced Filters. */
  showEntityFilters?: boolean;
  /** Unit the amount-range inputs/labels display in. Default 'btc'. */
  displayUnit?: AmountDisplayUnit;
  className?: string;
}

export const defaultFilters: SearchFilters = {
  dateMode: "any",
  amountMode: "any"
};

export function hasActiveSearchFilters(filters: SearchFilters): boolean {
  if (filters.dateMode === "range" && (filters.dateStart || filters.dateEnd)) return true;
  if (filters.dateMode === "exact" && filters.dateExact) return true;
  if (filters.amountMode === "range" && (filters.amountMinBtc !== undefined || filters.amountMaxBtc !== undefined)) return true;
  if (filters.amountMode === "exact" && filters.amountExactBtc !== undefined) return true;
  return false;
}

/** True when any entity dimension carries a value. */
export function hasActiveEntityFilters(filters: SearchFilters): boolean {
  return !!(
    filters.entityAddress?.trim() ||
    filters.entityWallet?.length ||
    filters.entitySeed?.length ||
    filters.entityOwner?.length ||
    filters.entityTag?.length ||
    filters.entityCategory?.length
  );
}

const ENTITY_DIMENSIONS = [
  { key: "entityWallet", label: "Wallet", optionsKey: "wallets" },
  { key: "entitySeed", label: "Seed", optionsKey: "seeds" },
  { key: "entityOwner", label: "Owner", optionsKey: "owners" },
  { key: "entityTag", label: "Tag", optionsKey: "tags" },
  { key: "entityCategory", label: "Category", optionsKey: "categories" },
] as const;

export function TransactionSearchFilters({ 
  filters, 
  onChange, 
  onClear,
  entityOptions,
  showEntityFilters = true,
  displayUnit = "btc",
  className 
}: TransactionSearchFiltersProps) {
  const [isOpen, setIsOpen] = useState(false);
  
  const hasEntity = showEntityFilters && hasActiveEntityFilters(filters);
  const hasFilters = hasActiveSearchFilters(filters) || hasEntity;
  const unitLabel = displayUnit === "sats" ? "Sats" : "BTC";
  const amountStep = displayUnit === "sats" ? "1" : "0.00000001";
  const amountPlaceholder = displayUnit === "sats" ? "0" : "0.00000000";

  const updateFilter = <K extends keyof SearchFilters>(key: K, value: SearchFilters[K]) => {
    onChange({ ...filters, [key]: value });
  };

  const formatDateRange = () => {
    if (filters.dateMode === "exact" && filters.dateExact) {
      return format(filters.dateExact, "MMM d, yyyy");
    }
    if (filters.dateMode === "range") {
      const parts: string[] = [];
      if (filters.dateStart) parts.push(format(filters.dateStart, "MMM d, yyyy"));
      if (filters.dateEnd) parts.push(format(filters.dateEnd, "MMM d, yyyy"));
      if (parts.length === 2) return `${parts[0]} - ${parts[1]}`;
      if (parts.length === 1) return filters.dateStart ? `From ${parts[0]}` : `Until ${parts[0]}`;
    }
    return null;
  };

  const formatAmountRange = () => {
    if (filters.amountMode === "exact" && filters.amountExactBtc !== undefined) {
      return formatDisplayAmount(filters.amountExactBtc, displayUnit);
    }
    if (filters.amountMode === "range") {
      const min = filters.amountMinBtc !== undefined ? formatDisplayAmount(filters.amountMinBtc, displayUnit) : undefined;
      const max = filters.amountMaxBtc !== undefined ? formatDisplayAmount(filters.amountMaxBtc, displayUnit) : undefined;
      if (min && max) return `${min} - ${max}`;
      if (min) return `Min ${min}`;
      if (max) return `Max ${max}`;
    }
    return null;
  };

  const dateDisplay = formatDateRange();
  const amountDisplay = formatAmountRange();
  const activeEntityCount = showEntityFilters
    ? (filters.entityAddress?.trim() ? 1 : 0) +
      ENTITY_DIMENSIONS.reduce((n, d) => n + (filters[d.key]?.length ?? 0), 0)
    : 0;

  return (
    <div className={cn("flex items-center gap-2 flex-wrap", className)}>
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverTrigger asChild>
          <Button 
            variant={hasFilters ? "default" : "outline"} 
            size="sm" 
            className="gap-2"
            data-testid="button-advanced-filters"
          >
            <Filter className="h-4 w-4" />
            Advanced Filters
            {hasFilters && (
              <span className="ml-1 rounded-full bg-primary-foreground text-primary h-5 w-5 text-xs flex items-center justify-center">
                {(dateDisplay ? 1 : 0) + (amountDisplay ? 1 : 0) + activeEntityCount}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-96 p-0" align="start">
          <div className="p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="font-medium">Search Filters</h4>
              {hasFilters && (
                <Button 
                  variant="ghost" 
                  size="sm" 
                  onClick={() => {
                    onClear();
                    setIsOpen(false);
                  }}
                  data-testid="button-clear-all-filters"
                >
                  Clear All
                </Button>
              )}
            </div>
            
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <CalendarDays className="h-4 w-4 text-muted-foreground" />
                <Label className="font-medium">Date</Label>
              </div>
              <Tabs 
                value={filters.dateMode} 
                onValueChange={(v) => updateFilter("dateMode", v as SearchFilters["dateMode"])}
              >
                <TabsList className="w-full">
                  <TabsTrigger value="any" className="flex-1" data-testid="tab-date-any">Any</TabsTrigger>
                  <TabsTrigger value="range" className="flex-1" data-testid="tab-date-range">Range</TabsTrigger>
                  <TabsTrigger value="exact" className="flex-1" data-testid="tab-date-exact">Exact</TabsTrigger>
                </TabsList>
                
                <TabsContent value="range" className="mt-3 space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs text-muted-foreground">From</Label>
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            className={cn(
                              "w-full justify-start text-left font-normal",
                              !filters.dateStart && "text-muted-foreground"
                            )}
                            data-testid="button-date-start"
                          >
                            <CalendarIcon className="mr-2 h-4 w-4" />
                            {filters.dateStart ? format(filters.dateStart, "MMM d, yyyy") : "Start date"}
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0" align="start">
                          <Calendar
                            mode="single"
                            selected={filters.dateStart}
                            onSelect={(d) => updateFilter("dateStart", d)}
                            disabled={(date) => filters.dateEnd ? date > filters.dateEnd : false}
                            initialFocus
                          />
                        </PopoverContent>
                      </Popover>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">To</Label>
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            className={cn(
                              "w-full justify-start text-left font-normal",
                              !filters.dateEnd && "text-muted-foreground"
                            )}
                            data-testid="button-date-end"
                          >
                            <CalendarIcon className="mr-2 h-4 w-4" />
                            {filters.dateEnd ? format(filters.dateEnd, "MMM d, yyyy") : "End date"}
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0" align="start">
                          <Calendar
                            mode="single"
                            selected={filters.dateEnd}
                            onSelect={(d) => updateFilter("dateEnd", d)}
                            disabled={(date) => filters.dateStart ? date < filters.dateStart : false}
                            initialFocus
                          />
                        </PopoverContent>
                      </Popover>
                    </div>
                  </div>
                </TabsContent>
                
                <TabsContent value="exact" className="mt-3">
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className={cn(
                          "w-full justify-start text-left font-normal",
                          !filters.dateExact && "text-muted-foreground"
                        )}
                        data-testid="button-date-exact"
                      >
                        <CalendarIcon className="mr-2 h-4 w-4" />
                        {filters.dateExact ? format(filters.dateExact, "MMM d, yyyy") : "Select date"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={filters.dateExact}
                        onSelect={(d) => updateFilter("dateExact", d)}
                        initialFocus
                      />
                    </PopoverContent>
                  </Popover>
                </TabsContent>
              </Tabs>
            </div>

            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <SiBitcoin className="h-4 w-4 text-muted-foreground" />
                <Label className="font-medium">{unitLabel} Amount</Label>
              </div>
              <Tabs 
                value={filters.amountMode} 
                onValueChange={(v) => updateFilter("amountMode", v as SearchFilters["amountMode"])}
              >
                <TabsList className="w-full">
                  <TabsTrigger value="any" className="flex-1" data-testid="tab-amount-any">Any</TabsTrigger>
                  <TabsTrigger value="range" className="flex-1" data-testid="tab-amount-range">Range</TabsTrigger>
                  <TabsTrigger value="exact" className="flex-1" data-testid="tab-amount-exact">Exact</TabsTrigger>
                </TabsList>
                
                <TabsContent value="range" className="mt-3 space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs text-muted-foreground">Min {unitLabel}</Label>
                      <Input
                        type="number"
                        step={amountStep}
                        min="0"
                        placeholder={amountPlaceholder}
                        value={btcToDisplay(filters.amountMinBtc, displayUnit) ?? ""}
                        onChange={(e) => {
                          const val = e.target.value;
                          updateFilter("amountMinBtc", val === "" ? undefined : displayToBtc(parseFloat(val), displayUnit));
                        }}
                        className="h-8"
                        data-testid="input-amount-min"
                      />
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">Max {unitLabel}</Label>
                      <Input
                        type="number"
                        step={amountStep}
                        min="0"
                        placeholder="No limit"
                        value={btcToDisplay(filters.amountMaxBtc, displayUnit) ?? ""}
                        onChange={(e) => {
                          const val = e.target.value;
                          updateFilter("amountMaxBtc", val === "" ? undefined : displayToBtc(parseFloat(val), displayUnit));
                        }}
                        className="h-8"
                        data-testid="input-amount-max"
                      />
                    </div>
                  </div>
                </TabsContent>
                
                <TabsContent value="exact" className="mt-3">
                  <div>
                    <Label className="text-xs text-muted-foreground">Exact {unitLabel} Amount</Label>
                    <Input
                      type="number"
                      step={amountStep}
                      min="0"
                      placeholder={amountPlaceholder}
                      value={btcToDisplay(filters.amountExactBtc, displayUnit) ?? ""}
                      onChange={(e) => {
                        const val = e.target.value;
                        updateFilter("amountExactBtc", val === "" ? undefined : displayToBtc(parseFloat(val), displayUnit));
                      }}
                      className="h-8"
                      data-testid="input-amount-exact"
                    />
                  </div>
                </TabsContent>
              </Tabs>
            </div>

            {showEntityFilters && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <LinkIcon className="h-4 w-4 text-muted-foreground" />
                  <Label className="font-medium">Linked Entity</Label>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Address</Label>
                  <Input
                    placeholder="Exact address"
                    value={filters.entityAddress ?? ""}
                    onChange={(e) => updateFilter("entityAddress", e.target.value === "" ? undefined : e.target.value)}
                    className="h-8 font-mono text-xs"
                    data-testid="input-entity-address"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {ENTITY_DIMENSIONS.map((dim) => {
                    const options = entityOptions?.[dim.optionsKey] ?? [];
                    const values = filters[dim.key] ?? [];
                    return (
                      <div key={dim.key}>
                        <Label className="text-xs text-muted-foreground">{dim.label}</Label>
                        <MultiSelectCombobox
                          values={values}
                          onChange={(v) => updateFilter(dim.key, v.length ? v : undefined)}
                          options={options}
                          placeholder="Any"
                          searchPlaceholder={`Search ${dim.label.toLowerCase()}...`}
                          testId={`select-entity-${dim.label.toLowerCase()}`}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="pt-2 flex justify-end">
              <Button 
                size="sm" 
                onClick={() => setIsOpen(false)}
                data-testid="button-apply-filters"
              >
                Apply Filters
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {dateDisplay && (
        <div className="flex items-center gap-1 text-sm bg-muted px-2 py-1 rounded-md">
          <CalendarDays className="h-3 w-3 text-muted-foreground" />
          <span>{dateDisplay}</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-4 w-4 p-0 hover:bg-transparent"
            onClick={() => {
              onChange({ 
                ...filters, 
                dateMode: "any", 
                dateStart: undefined, 
                dateEnd: undefined, 
                dateExact: undefined 
              });
            }}
            data-testid="button-clear-date-filter"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}

      {amountDisplay && (
        <div className="flex items-center gap-1 text-sm bg-muted px-2 py-1 rounded-md">
          <SiBitcoin className="h-3 w-3 text-muted-foreground" />
          <span>{amountDisplay}</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-4 w-4 p-0 hover:bg-transparent"
            onClick={() => {
              onChange({ 
                ...filters, 
                amountMode: "any", 
                amountMinBtc: undefined, 
                amountMaxBtc: undefined, 
                amountExactBtc: undefined 
              });
            }}
            data-testid="button-clear-amount-filter"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}

      {filters.entityAddress?.trim() && (
        <div className="flex items-center gap-1 text-sm bg-muted px-2 py-1 rounded-md" data-testid="chip-entity-address">
          <LinkIcon className="h-3 w-3 text-muted-foreground" />
          <span className="font-mono text-xs max-w-[160px] truncate">{filters.entityAddress}</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-4 w-4 p-0 hover:bg-transparent"
            onClick={() => onChange({ ...filters, entityAddress: undefined })}
            data-testid="button-clear-entity-address"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
      {ENTITY_DIMENSIONS.map((dim) => {
        const values = filters[dim.key];
        if (!values || values.length === 0) return null;
        return (
          <div
            key={dim.key}
            className="flex items-center gap-1 text-sm bg-muted px-2 py-1 rounded-md"
            data-testid={`chip-entity-${dim.label.toLowerCase()}`}
          >
            <LinkIcon className="h-3 w-3 text-muted-foreground" />
            <span className="max-w-[220px] truncate">{dim.label}: {values.join(", ")}</span>
            <Button
              variant="ghost"
              size="icon"
              className="h-4 w-4 p-0 hover:bg-transparent"
              onClick={() => onChange({ ...filters, [dim.key]: undefined })}
              data-testid={`button-clear-entity-${dim.label.toLowerCase()}`}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}

export function filterByDateAndAmount<T>(
  items: T[],
  filters: SearchFilters,
  getBlockTime: (item: T) => number,
  getAmountSats: (item: T) => number
): T[] {
  return items.filter(item => {
    const blockTime = getBlockTime(item);
    const amountBtc = getAmountSats(item) / 100_000_000;

    if (filters.dateMode === "exact" && filters.dateExact) {
      const itemDate = new Date(blockTime * 1000);
      const filterDate = filters.dateExact;
      if (
        itemDate.getFullYear() !== filterDate.getFullYear() ||
        itemDate.getMonth() !== filterDate.getMonth() ||
        itemDate.getDate() !== filterDate.getDate()
      ) {
        return false;
      }
    }

    if (filters.dateMode === "range") {
      const itemDate = new Date(blockTime * 1000);
      if (filters.dateStart) {
        const startOfDay = new Date(filters.dateStart);
        startOfDay.setHours(0, 0, 0, 0);
        if (itemDate < startOfDay) return false;
      }
      if (filters.dateEnd) {
        const endOfDay = new Date(filters.dateEnd);
        endOfDay.setHours(23, 59, 59, 999);
        if (itemDate > endOfDay) return false;
      }
    }

    if (filters.amountMode === "exact" && filters.amountExactBtc !== undefined) {
      const tolerance = 0.000000005;
      if (Math.abs(amountBtc - filters.amountExactBtc) > tolerance) {
        return false;
      }
    }

    if (filters.amountMode === "range") {
      if (filters.amountMinBtc !== undefined && amountBtc < filters.amountMinBtc) {
        return false;
      }
      if (filters.amountMaxBtc !== undefined && amountBtc > filters.amountMaxBtc) {
        return false;
      }
    }

    return true;
  });
}
