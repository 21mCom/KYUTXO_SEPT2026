import { useState } from "react";
import { Check, ChevronsUpDown, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface MultiSelectComboboxProps {
  values: string[];
  onChange: (values: string[]) => void;
  options: string[];
  onAddNew?: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  testId?: string;
  className?: string;
  /** Presentation labels for stable stored option values. */
  optionLabels?: Record<string, string>;
}

export function MultiSelectCombobox({
  values,
  onChange,
  options,
  onAddNew,
  placeholder = "Select items...",
  searchPlaceholder = "Search or add new...",
  disabled = false,
  testId,
  className,
  optionLabels,
}: MultiSelectComboboxProps) {
  const labelFor = (item: string) => optionLabels?.[item] ?? item;
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState("");

  const handleSelect = (item: string) => {
    if (values.includes(item)) {
      onChange(values.filter((v) => v !== item));
    } else {
      onChange([...values, item]);
    }
  };

  const handleRemove = (item: string) => {
    onChange(values.filter((v) => v !== item));
  };

  const handleAddNew = () => {
    if (inputValue.trim() && onAddNew) {
      const newValue = inputValue.trim();
      if (!options.some((o) => o.toLowerCase() === newValue.toLowerCase())) {
        onAddNew(newValue);
      }
      if (!values.includes(newValue)) {
        onChange([...values, newValue]);
      }
      setInputValue("");
    }
  };

  const availableOptions = options.filter((o) => !values.includes(o));
  const isNewValue = inputValue.trim() && 
    !options.some((o) => o.toLowerCase() === inputValue.trim().toLowerCase());

  return (
    <div className={cn("space-y-2", className)}>
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {values.map((item) => (
            <Badge
              key={item}
              variant="secondary"
              className="gap-1 pr-1"
            >
              {labelFor(item)}
              <button
                type="button"
                onClick={() => handleRemove(item)}
                className="ml-1 rounded-full hover:bg-muted-foreground/20 p-0.5"
                disabled={disabled}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between font-normal"
            disabled={disabled}
            data-testid={testId}
          >
            {values.length === 0 ? placeholder : `${values.length} selected`}
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-full p-0" align="start">
          <Command>
            <CommandInput
              placeholder={searchPlaceholder}
              value={inputValue}
              onValueChange={setInputValue}
            />
            <CommandList>
              <CommandEmpty>
                {isNewValue && onAddNew ? (
                  <Button
                    variant="ghost"
                    className="w-full justify-start"
                    onClick={handleAddNew}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Add "{inputValue.trim()}"
                  </Button>
                ) : (
                  <span className="text-sm text-muted-foreground p-2">No results found</span>
                )}
              </CommandEmpty>
              <CommandGroup>
                {availableOptions.map((item) => (
                  <CommandItem
                    key={item}
                    value={item}
                    onSelect={() => handleSelect(item)}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        values.includes(item) ? "opacity-100" : "opacity-0"
                      )}
                    />
                    {labelFor(item)}
                  </CommandItem>
                ))}
                {isNewValue && onAddNew && (
                  <CommandItem
                    value={`create-${inputValue.trim()}`}
                    onSelect={handleAddNew}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Add "{inputValue.trim()}"
                  </CommandItem>
                )}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
