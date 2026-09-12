import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, Loader2, MapPin, Search, Terminal } from "lucide-react";
import { useLocation } from "wouter";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { getNavigationItems, type NavItem } from "@/config/navigation";
import { useRecordPreview } from "@/contexts/RecordPreviewContext";
import {
  getRecordsByInputString,
  searchVisibleRecordsBounded,
} from "@/lib/data/record-crud";
import { looksLikeBitcoinIdentifier } from "@/lib/records-query";
import { isHiddenDiscoveryTier } from "@/lib/db-types";
import type { Record as DbRecord } from "@/lib/database";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { DEBOUNCE_DELAY } from "@/config/debounce";

const RESULT_LIMIT = 8;
const MAX_SEARCH_SCANNED = 2_000;

function recordSearchText(record: DbRecord): string {
  return [
    record.label,
    record.inputString,
    record.owner,
    record.walletName,
    record.seedName,
    record.walletSoftware,
    record.notes,
    record.source,
    record.privateKeyStatus,
    ...(record.tags ?? []),
    ...(record.categories ?? []),
    ...Object.values(record.customFields ?? {}),
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

function scoreRecord(record: DbRecord, query: string): number {
  const term = query.toLowerCase();
  const label = (record.label ?? "").toLowerCase();
  const identifier = (record.inputString ?? "").toLowerCase();
  let score = 0;

  if (label === term) score += 100;
  else if (label.startsWith(term)) score += 70;
  else if (label.includes(term)) score += 50;
  if (identifier === term) score += 120;
  else if (identifier.startsWith(term)) score += 65;
  else if (identifier.includes(term)) score += 35;
  if ((record.owner ?? "").toLowerCase().includes(term)) score += 28;
  if ((record.walletName ?? "").toLowerCase().includes(term)) score += 26;
  if ((record.tags ?? []).some((tag) => tag.toLowerCase() === term)) score += 24;
  if ((record.categories ?? []).some((category) => category.toLowerCase() === term)) score += 22;
  if ((record.notes ?? "").toLowerCase().includes(term)) score += 14;
  if (Object.values(record.customFields ?? {}).some((value) => value.toLowerCase().includes(term))) score += 12;
  // Prefer the newest row when two records have the same metadata match.
  return score * 1_000_000 + (record.id ?? 0);
}

function recordDescription(record: DbRecord): string {
  const metadata = [record.owner, record.walletName, ...(record.tags ?? [])]
    .filter(Boolean)
    .slice(0, 2)
    .join(" · ");
  return metadata || record.type;
}

export function GlobalCommandPalette() {
  const [, navigate] = useLocation();
  const { openRecordPreview } = useRecordPreview();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, isPending] = useDebouncedValue(query, DEBOUNCE_DELAY.SMALL);
  const [recordResults, setRecordResults] = useState<DbRecord[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const searchVersion = useRef(0);
  const navigationItems = useMemo(
    () => getNavigationItems(import.meta.env.DEV),
    [],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() === "k" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey
      ) {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setRecordResults([]);
      setSearchFailed(false);
      return;
    }

    const term = debouncedQuery.trim();
    const version = ++searchVersion.current;
    if (!term) {
      setRecordResults([]);
      setSearching(false);
      setSearchFailed(false);
      return;
    }

    setSearching(true);
    setSearchFailed(false);
    (async () => {
      try {
        const identifier = looksLikeBitcoinIdentifier(term);
        let rows: DbRecord[];
        if (identifier) {
          // Exact identifier searches use the canonical inputString index and
          // never fall back to a notes/label substring search.
          rows = await getRecordsByInputString(identifier);
          rows = rows.filter((record) => !isHiddenDiscoveryTier(record.addressImportance));
        } else {
          rows = await searchVisibleRecordsBounded(term, {
            perIndexLimit: 50,
            recentScanLimit: MAX_SEARCH_SCANNED,
            isCancelled: () => searchVersion.current !== version,
          });
        }

        if (searchVersion.current !== version) return;
        rows.sort((a, b) => scoreRecord(b, term) - scoreRecord(a, term));
        setRecordResults(rows.slice(0, RESULT_LIMIT));
      } catch (error) {
        console.warn("[GlobalCommandPalette] local search failed:", error);
        if (searchVersion.current === version) {
          setRecordResults([]);
          setSearchFailed(true);
        }
      } finally {
        if (searchVersion.current === version) setSearching(false);
      }
    })();
  }, [debouncedQuery, open]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  const choosePage = useCallback((item: NavItem) => {
    close();
    navigate(item.url);
  }, [close, navigate]);

  const chooseRecord = useCallback(async (record: DbRecord) => {
    close();
    if (record.id == null) return;
    await openRecordPreview(record.id);
  }, [close, openRecordPreview]);

  const hasQuery = query.trim().length > 0;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="hidden items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 text-xs text-muted-foreground shadow-sm transition-colors hover:bg-muted sm:flex"
        aria-label="Search pages and records"
        title="Search pages and records (Cmd/Ctrl+K)"
        data-testid="button-command-search"
      >
        <Search className="h-3.5 w-3.5" />
        <span>Search</span>
        <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
      </button>

      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search pages, addresses, transactions, or metadata…"
          aria-label="Search pages, addresses, transactions, or metadata"
          data-testid="input-command-search"
        />
        <CommandList data-testid="list-command-search-results">
          {!hasQuery && (
            <CommandGroup heading="Pages & actions">
              {navigationItems.map((item) => {
                const Icon = item.icon;
                return (
                  <CommandItem
                    key={item.url}
                    value={[item.title, ...(item.aliases ?? [])].join(" ")}
                    onSelect={() => choosePage(item)}
                    data-testid={`command-page-${item.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                  >
                    <Icon className="h-4 w-4" />
                    <span>{item.title}</span>
                    <CommandShortcut>{item.url === "/" ? "Home" : item.url}</CommandShortcut>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}

          {hasQuery && (
            <>
              <CommandGroup heading="Pages & actions">
                {navigationItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <CommandItem
                      key={item.url}
                      value={[item.title, ...(item.aliases ?? [])].join(" ")}
                      onSelect={() => choosePage(item)}
                      data-testid={`command-page-${item.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                    >
                      <Icon className="h-4 w-4" />
                      <span>{item.title}</span>
                      <CommandShortcut>{item.url === "/" ? "Home" : item.url}</CommandShortcut>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading="Vault matches">
                {searching && (
                  <CommandItem value="searching" disabled forceMount>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Searching your local vault…</span>
                  </CommandItem>
                )}
                {!searching && recordResults.map((record) => (
                  <CommandItem
                    key={record.id}
                    value={recordSearchText(record)}
                    onSelect={() => void chooseRecord(record)}
                    data-testid={`command-record-${record.id}`}
                  >
                    {record.type === "address" ? <MapPin className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
                    <span className="min-w-0 truncate">
                      <span className="block truncate">{record.label || record.inputString}</span>
                      <span className="block truncate text-xs text-muted-foreground">{recordDescription(record)} · {record.inputString}</span>
                    </span>
                  </CommandItem>
                ))}
                {!searching && searchFailed && (
                  <CommandItem value="search failed" disabled forceMount>
                    <Terminal className="h-4 w-4" />
                    <span>Local search is temporarily unavailable</span>
                  </CommandItem>
                )}
              </CommandGroup>
            </>
          )}
          <CommandEmpty>
            {isPending ? "Preparing search…" : hasQuery ? "No visible pages or vault matches." : "No pages found."}
          </CommandEmpty>
        </CommandList>
      </CommandDialog>
    </>
  );
}