import { useMemo, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";

export interface EntityPickerOption {
  /** The value stored/emitted when this option is chosen. */
  value: string;
  /** Primary display text; falls back to `value` when omitted. */
  label?: string;
  /** Secondary badge text shown next to the option (e.g. an owner name). */
  sublabel?: string;
  /** Short badge text shown before the label (e.g. an importance tier). */
  badge?: string;
  /** Extra text folded into the search haystack beyond value/label/sublabel. */
  searchText?: string;
}

interface CommonProps {
  options: EntityPickerOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  maxResults?: number;
  /** Render values in a monospace font (addresses, txids, ...). */
  monospace?: boolean;
  /** Permit committing values that don't match any option (free text). */
  allowFreeText?: boolean;
  /** Extra validation gating free-text entry (e.g. bitcoin address format). */
  validateFreeText?: (value: string) => boolean;
  /** Invoked when Enter is pressed in the input (single mode only). */
  onEnter?: () => void;
  disabled?: boolean;
  testId?: string;
  className?: string;
}

interface SingleSelectProps extends CommonProps {
  multiple?: false;
  value: string;
  onChange: (value: string) => void;
}

interface MultiSelectProps extends CommonProps {
  multiple: true;
  value: string[];
  onChange: (value: string[]) => void;
}

export type SearchableEntityPickerProps = SingleSelectProps | MultiSelectProps;

function matchesQuery(option: EntityPickerOption, query: string): boolean {
  const q = query.toLowerCase();
  const haystack = [option.value, option.label, option.sublabel, option.searchText]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

/**
 * Shared searchable picker for choosing one or more addresses/entities from
 * a known list, generalizing the address+label+owner Command/Popover picker
 * originally built for Provenance. Supports optional free-text entry for
 * values (e.g. raw addresses) not present in `options`, and multi-select
 * with removable chips plus bulk paste (one value per line, or comma /
 * semicolon separated).
 */
export function SearchableEntityPicker(props: SearchableEntityPickerProps) {
  const {
    options,
    placeholder = "Search or type a value...",
    searchPlaceholder = "Search...",
    emptyText = "No matches found",
    maxResults = 100,
    monospace = false,
    allowFreeText = false,
    validateFreeText,
    onEnter,
    disabled = false,
    testId = "entity-picker",
    className,
  } = props;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");

  const filtered = useMemo(() => {
    const list = query.trim() ? options.filter((o) => matchesQuery(o, query.trim())) : options;
    return list.slice(0, maxResults);
  }, [options, query, maxResults]);

  const optionByValue = useMemo(() => {
    const map = new Map<string, EntityPickerOption>();
    for (const o of options) map.set(o.value, o);
    return map;
  }, [options]);

  const selectedValues: string[] = props.multiple ? props.value : props.value ? [props.value] : [];

  const canCommit = (raw: string): boolean => {
    const value = raw.trim();
    if (!value) return false;
    if (optionByValue.has(value)) return true;
    if (!allowFreeText) return false;
    if (validateFreeText && !validateFreeText(value)) return false;
    return true;
  };

  const commit = (raw: string) => {
    const value = raw.trim();
    if (!canCommit(value)) return;
    if (props.multiple) {
      if (!props.value.includes(value)) {
        props.onChange([...props.value, value]);
      }
    } else {
      props.onChange(value);
    }
  };

  const handleSelect = (value: string) => {
    if (props.multiple) {
      if (props.value.includes(value)) {
        props.onChange(props.value.filter((v) => v !== value));
      } else {
        props.onChange([...props.value, value]);
      }
    } else {
      props.onChange(value);
      setOpen(false);
      setQuery("");
    }
  };

  const removeValue = (value: string) => {
    if (props.multiple) {
      props.onChange(props.value.filter((v) => v !== value));
    } else {
      props.onChange("");
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    if (props.multiple) {
      e.preventDefault();
      if (draft.trim()) {
        commit(draft);
        setDraft("");
      }
    } else if (onEnter) {
      onEnter();
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    if (!props.multiple) return;
    const text = e.clipboardData.getData("text");
    if (!/[\n,;]/.test(text)) return;
    e.preventDefault();
    const parts = text
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const part of parts) commit(part);
    setDraft("");
  };

  const inputValue = props.multiple ? draft : props.value;
  const setInputValue = (v: string) => (props.multiple ? setDraft(v) : props.onChange(v));

  return (
    <div className={cn("space-y-2", className)} data-testid={testId}>
      {props.multiple && selectedValues.length > 0 && (
        <div className="flex flex-wrap gap-1.5" data-testid={`${testId}-selected`}>
          {selectedValues.map((v) => {
            const opt = optionByValue.get(v);
            return (
              <Badge key={v} variant="secondary" className="gap-1 pr-1" data-testid={`${testId}-chip`}>
                <span className={cn(monospace && "font-mono", "truncate max-w-[160px]")}>{opt?.label || v}</span>
                <button
                  type="button"
                  onClick={() => removeValue(v)}
                  className="hover:opacity-70"
                  aria-label={`Remove ${v}`}
                  data-testid={`${testId}-remove`}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            );
          })}
        </div>
      )}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={placeholder}
            disabled={disabled}
            className={cn(monospace && "font-mono text-sm", "pr-8")}
            data-testid={`input-${testId}`}
          />
          {inputValue && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-0 top-0 h-full px-2 hover:bg-transparent"
              onClick={() => setInputValue("")}
              disabled={disabled}
              data-testid={`button-${testId}-clear-input`}
            >
              <X className="h-4 w-4 text-muted-foreground" />
            </Button>
          )}
        </div>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" size="icon" disabled={disabled} data-testid={`button-${testId}-open`}>
              <ChevronDown className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[400px] p-0" align="end">
            <Command shouldFilter={false}>
              <CommandInput
                placeholder={searchPlaceholder}
                value={query}
                onValueChange={setQuery}
                data-testid={`input-${testId}-search`}
              />
              <CommandList>
                <CommandEmpty>{emptyText}</CommandEmpty>
                <CommandGroup heading={`${options.length} option(s) (showing up to ${maxResults})`}>
                  {filtered.map((option) => {
                    const isSelected = selectedValues.includes(option.value);
                    return (
                      <CommandItem
                        key={option.value}
                        value={option.value}
                        onSelect={() => handleSelect(option.value)}
                        className="flex items-center gap-2"
                        data-testid={`${testId}-option-${option.value}`}
                      >
                        <Check className={cn("h-4 w-4", isSelected ? "opacity-100" : "opacity-0")} />
                        {option.badge && (
                          <Badge variant="outline" className="text-xs shrink-0">
                            {option.badge}
                          </Badge>
                        )}
                        <div className="flex flex-col flex-1 min-w-0">
                          <span className="truncate font-medium">{option.label || option.value}</span>
                          {option.label && (
                            <span
                              className={cn("text-xs text-muted-foreground truncate", monospace && "font-mono")}
                            >
                              {option.value}
                            </span>
                          )}
                        </div>
                        {option.sublabel && (
                          <Badge variant="outline" className="text-xs shrink-0">
                            {option.sublabel}
                          </Badge>
                        )}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
