import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";

interface Filter {
  type?: "address" | "transaction" | "other" | "all";
  tags: string[];
  categories: string[];
}

interface TableColumns {
  tags: boolean;
  categories: boolean;
  walletSoftware: boolean;
  seedName: boolean;
  privateKeyStatus: boolean;
  hasAttachments: boolean;
  source: boolean;
}

interface FilterBarProps {
  filter: Filter;
  onChange: (filter: Filter) => void;
  availableTags?: string[];
  availableCategories?: string[];
  tableColumns?: TableColumns;
}

export function FilterBar({ filter, onChange, availableTags = [], availableCategories = [], tableColumns }: FilterBarProps) {
  const showTagsFilter = tableColumns?.tags !== false;
  const showCategoriesFilter = tableColumns?.categories !== false;
  
  const prevShowTags = useRef(showTagsFilter);
  const prevShowCategories = useRef(showCategoriesFilter);
  
  useEffect(() => {
    let updatedFilter = { ...filter };
    let needsUpdate = false;
    
    if (prevShowTags.current && !showTagsFilter && filter.tags.length > 0) {
      updatedFilter.tags = [];
      needsUpdate = true;
    }
    
    if (prevShowCategories.current && !showCategoriesFilter && filter.categories.length > 0) {
      updatedFilter.categories = [];
      needsUpdate = true;
    }
    
    if (needsUpdate) {
      onChange(updatedFilter);
    }
    
    prevShowTags.current = showTagsFilter;
    prevShowCategories.current = showCategoriesFilter;
  }, [showTagsFilter, showCategoriesFilter]);
  
  const hasActiveFilters = filter.type !== "all" || filter.tags.length > 0 || filter.categories.length > 0;

  const clearAllFilters = () => {
    onChange({ type: "all", tags: [], categories: [] });
  };


  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={filter.type || "all"}
          onValueChange={(value) => onChange({ ...filter, type: value as Filter["type"] })}
        >
          <SelectTrigger className="w-[140px]" data-testid="select-type-filter">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="address">Bitcoin Addresses</SelectItem>
            <SelectItem value="transaction">Transactions</SelectItem>
            <SelectItem value="other">Other</SelectItem>
          </SelectContent>
        </Select>

        {showTagsFilter && availableTags.length > 0 && (
          <div className="w-[180px]">
            <MultiSelectCombobox
              values={filter.tags}
              onChange={(tags) => onChange({ ...filter, tags })}
              options={availableTags}
              placeholder="Filter by tags..."
              searchPlaceholder="Search tags..."
              testId="select-tag-filter"
            />
          </div>
        )}

        {showCategoriesFilter && availableCategories.length > 0 && (
          <div className="w-[180px]">
            <MultiSelectCombobox
              values={filter.categories}
              onChange={(categories) => onChange({ ...filter, categories })}
              options={availableCategories}
              placeholder="Filter by category..."
              searchPlaceholder="Search categories..."
              testId="select-category-filter"
            />
          </div>
        )}

        {hasActiveFilters && (
          <Button variant="ghost" size="sm" onClick={clearAllFilters} data-testid="button-clear-filters">
            Clear all
          </Button>
        )}
      </div>

    </div>
  );
}
