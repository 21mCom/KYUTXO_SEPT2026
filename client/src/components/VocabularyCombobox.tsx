import { useState, useMemo, useEffect } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronsUpDown, Check, Plus, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ensureSelectableVocabularyEntry } from "@/lib/dataFacade";

const VOCABULARY_KIND_MAP = {
  tags: 'tag',
  categories: 'category',
  owners: 'owner',
  walletNames: 'walletName',
  seedNames: 'seedName',
  walletSoftware: 'walletSoftware',
} as const;

interface VocabularyComboboxProps {
  fieldKey: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder: string;
  vocabularyKey?: 'owners' | 'walletNames' | 'seedNames' | 'walletSoftware' | 'tags' | 'categories';
  /** Override the trigger button's data-testid (defaults to `combobox-value-${fieldKey}`). */
  triggerTestId?: string;
  /** Override the trigger button's className (e.g. full-width layouts). */
  triggerClassName?: string;
  /** Override the search input placeholder. */
  searchPlaceholder?: string;
  /** Hard cap on the search input length (e.g. seed names). */
  inputMaxLength?: number;
  /** Optional per-option annotation rendered after the label (e.g. "(detected)"). */
  optionAnnotations?: Record<string, string>;
}

export function VocabularyCombobox({
  fieldKey,
  value,
  onChange,
  options,
  placeholder,
  vocabularyKey,
  triggerTestId,
  triggerClassName,
  searchPlaceholder,
  inputMaxLength,
  optionAnnotations
}: VocabularyComboboxProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState(value);
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    setInputValue(value);
  }, [value]);

  const filteredOptions = useMemo(() =>
    options.filter(opt =>
      opt.label.toLowerCase().includes(inputValue.toLowerCase())
    ),
    [options, inputValue]
  );

  const showCreateNew = vocabularyKey && inputValue.trim() !== '' &&
    !options.some(opt => opt.value.toLowerCase() === inputValue.toLowerCase());

  const handleCreateNew = async () => {
    if (!vocabularyKey || !inputValue.trim()) return;

    const trimmedValue = inputValue.trim();
    setIsCreating(true);

    try {
      const addedValue = await ensureSelectableVocabularyEntry(
        VOCABULARY_KIND_MAP[vocabularyKey],
        trimmedValue,
      );

      onChange(addedValue);
      setOpen(false);
      toast({
        title: "Created",
        description: `"${addedValue}" has been added`,
      });
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Creation failed",
        description: error instanceof Error ? error.message : "Could not create item",
      });
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={triggerClassName ?? "w-[180px] justify-between font-normal"}
          data-testid={triggerTestId ?? `combobox-value-${fieldKey}`}
        >
          <span className="truncate">
            {value || placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[220px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={searchPlaceholder ?? `Type or search...`}
            value={inputValue}
            onValueChange={(val) => setInputValue(inputMaxLength ? val.slice(0, inputMaxLength) : val)}
            maxLength={inputMaxLength}
            data-testid={`input-combobox-${fieldKey}`}
          />
          <CommandList>
            {filteredOptions.length === 0 && !showCreateNew && (
              <CommandEmpty>No options found.</CommandEmpty>
            )}
            {showCreateNew && (
              <CommandGroup heading="Create new">
                <CommandItem
                  value={`create:${inputValue}`}
                  onSelect={handleCreateNew}
                  disabled={isCreating}
                  data-testid={`option-create-new-${fieldKey}`}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  {isCreating ? "Creating..." : `Create "${inputValue.trim()}"`}
                </CommandItem>
              </CommandGroup>
            )}
            {filteredOptions.length > 0 && (
              <CommandGroup heading="Existing values">
                {filteredOptions.map(opt => (
                  <CommandItem
                    key={opt.value}
                    value={opt.value}
                    onSelect={() => {
                      onChange(opt.value);
                      setInputValue(opt.value);
                      setOpen(false);
                    }}
                    data-testid={`option-${fieldKey}-${opt.value}`}
                  >
                    <Check
                      className={`mr-2 h-4 w-4 ${value === opt.value ? 'opacity-100' : 'opacity-0'}`}
                    />
                    {opt.label}
                    {optionAnnotations?.[opt.value] && (
                      <span className="ml-2 text-xs text-muted-foreground">{optionAnnotations[opt.value]}</span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

interface VocabularyMultiSelectProps {
  fieldKey: string;
  values: string[];
  onChange: (v: string[]) => void;
  options: { value: string; label: string }[];
  placeholder: string;
  vocabularyKey?: 'owners' | 'walletNames' | 'seedNames' | 'walletSoftware' | 'tags' | 'categories';
}

export function VocabularyMultiSelect({
  fieldKey,
  values,
  onChange,
  options,
  placeholder,
  vocabularyKey
}: VocabularyMultiSelectProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  const filteredOptions = useMemo(() =>
    options.filter(opt =>
      opt.label.toLowerCase().includes(searchInput.toLowerCase())
    ),
    [options, searchInput]
  );

  const showCreateNew = vocabularyKey && searchInput.trim() !== '' &&
    !options.some(opt => opt.value.toLowerCase() === searchInput.toLowerCase());

  const handleCreateNew = async () => {
    if (!vocabularyKey || !searchInput.trim()) return;

    const trimmedValue = searchInput.trim();
    setIsCreating(true);

    try {
      const addedValue = await ensureSelectableVocabularyEntry(
        VOCABULARY_KIND_MAP[vocabularyKey],
        trimmedValue,
      );
      if (!values.includes(addedValue)) {
        onChange([...values, addedValue]);
      }
      setSearchInput("");
      toast({
        title: "Created",
        description: `Added "${addedValue}" to vocabulary`,
      });
    } catch (error) {
      console.error('Failed to create vocabulary item:', error);
      toast({
        title: "Failed to create",
        description: "Could not create new vocabulary item",
        variant: "destructive",
      });
    } finally {
      setIsCreating(false);
    }
  };

  const toggleValue = (optValue: string) => {
    if (values.includes(optValue)) {
      onChange(values.filter(v => v !== optValue));
    } else {
      onChange([...values, optValue]);
    }
  };

  const removeValue = (optValue: string) => {
    onChange(values.filter(v => v !== optValue));
  };

  return (
    <div className="flex flex-col gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-[220px] justify-between h-auto min-h-9"
            data-testid={`multiselect-filter-${fieldKey}`}
          >
            <span className="truncate text-left flex-1">
              {values.length === 0
                ? placeholder
                : values.length === 1
                ? values[0]
                : `${values.length} selected`
              }
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[220px] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search or type new..."
              value={searchInput}
              onValueChange={setSearchInput}
              data-testid={`multiselect-search-${fieldKey}`}
            />
            <CommandList>
              <CommandEmpty>
                {showCreateNew ? (
                  <div className="text-sm text-muted-foreground py-2">
                    Press enter or click below to create
                  </div>
                ) : (
                  "No results found"
                )}
              </CommandEmpty>
              {showCreateNew && (
                <CommandGroup heading="Create new">
                  <CommandItem
                    value={`create:${searchInput}`}
                    onSelect={handleCreateNew}
                    disabled={isCreating}
                    data-testid={`multiselect-create-${fieldKey}`}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    {isCreating ? "Creating..." : `Create "${searchInput.trim()}"`}
                  </CommandItem>
                </CommandGroup>
              )}
              {filteredOptions.length > 0 && (
                <CommandGroup heading="Select values">
                  {filteredOptions.map(opt => (
                    <CommandItem
                      key={opt.value}
                      value={opt.value}
                      onSelect={() => toggleValue(opt.value)}
                      data-testid={`multiselect-option-${fieldKey}-${opt.value}`}
                    >
                      <Check
                        className={`mr-2 h-4 w-4 ${values.includes(opt.value) ? 'opacity-100' : 'opacity-0'}`}
                      />
                      {opt.label}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {/* Show selected values as badges */}
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1 max-w-[220px]">
          {values.map(v => (
            <Badge
              key={v}
              variant="secondary"
              className="text-xs gap-1 cursor-pointer"
              onClick={() => removeValue(v)}
              data-testid={`multiselect-badge-${fieldKey}-${v}`}
            >
              {v}
              <X className="h-3 w-3" />
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
