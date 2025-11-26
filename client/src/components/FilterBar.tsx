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

interface Filter {
  type?: "address" | "transaction" | "other" | "all";
  tags: string[];
  categories: string[];
}

interface FilterBarProps {
  filter: Filter;
  onChange: (filter: Filter) => void;
  availableTags?: string[];
  availableCategories?: string[];
}

export function FilterBar({ filter, onChange, availableTags = [], availableCategories = [] }: FilterBarProps) {
  const hasActiveFilters = filter.type !== "all" || filter.tags.length > 0 || filter.categories.length > 0;

  const clearAllFilters = () => {
    onChange({ type: "all", tags: [], categories: [] });
  };

  const removeTag = (tag: string) => {
    onChange({ ...filter, tags: filter.tags.filter(t => t !== tag) });
  };

  const removeCategory = (category: string) => {
    onChange({ ...filter, categories: filter.categories.filter(c => c !== category) });
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
            <SelectItem value="other">Other Coins</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value=""
          onValueChange={(value) => {
            if (!filter.tags.includes(value)) {
              onChange({ ...filter, tags: [...filter.tags, value] });
            }
          }}
        >
          <SelectTrigger className="w-[140px]" data-testid="select-tag-filter">
            <SelectValue placeholder="Add tag filter" />
          </SelectTrigger>
          <SelectContent>
            {availableTags.map((tag) => (
              <SelectItem key={tag} value={tag}>{tag}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value=""
          onValueChange={(value) => {
            if (!filter.categories.includes(value)) {
              onChange({ ...filter, categories: [...filter.categories, value] });
            }
          }}
        >
          <SelectTrigger className="w-[160px]" data-testid="select-category-filter">
            <SelectValue placeholder="Add category filter" />
          </SelectTrigger>
          <SelectContent>
            {availableCategories.map((category) => (
              <SelectItem key={category} value={category}>{category}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {hasActiveFilters && (
          <Button variant="ghost" size="sm" onClick={clearAllFilters} data-testid="button-clear-filters">
            Clear all
          </Button>
        )}
      </div>

      {(filter.tags.length > 0 || filter.categories.length > 0) && (
        <div className="flex flex-wrap gap-2">
          {filter.tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="gap-1" data-testid={`badge-filter-tag-${tag}`}>
              Tag: {tag}
              <X className="h-3 w-3 cursor-pointer" onClick={() => removeTag(tag)} />
            </Badge>
          ))}
          {filter.categories.map((category) => (
            <Badge key={category} variant="secondary" className="gap-1" data-testid={`badge-filter-category-${category}`}>
              Category: {category}
              <X className="h-3 w-3 cursor-pointer" onClick={() => removeCategory(category)} />
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
