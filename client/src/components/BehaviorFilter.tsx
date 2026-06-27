import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Activity, X } from "lucide-react";
import { type BehaviorLabel, BEHAVIOR_LABEL_DISPLAY } from "@/lib/behavior-profile";

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
}

export function BehaviorFilter({ selected, onChange }: BehaviorFilterProps) {
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
          <PopoverContent className="w-56 p-2" align="start">
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
