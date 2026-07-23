import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronDown,
  ChevronRight,
  Search,
  Copy,
  Download,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import type { EntitySnapshotError, EntitySnapshotErrorKind } from "@/lib/data/entity-list-store";
import { ENTITY_ERROR_KIND_LABELS } from "@/lib/data/entity-list-store";
import { downloadBlob } from "@/lib/backup/sink";

export const ENTITY_ERROR_ROW_HEIGHT = 44;
export const ENTITY_ERROR_VIRTUALIZE_THRESHOLD = 100;

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the execCommand fallback below.
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function entityErrorLabel(err: EntitySnapshotError): string {
  return err.index >= 0 ? `Entry ${err.index + 1}` : "File";
}

function EntityErrorRow({
  err,
  index,
  style,
}: {
  err: EntitySnapshotError;
  index: number;
  style?: React.CSSProperties;
}) {
  const label = entityErrorLabel(err);
  return (
    <div
      className="border-b border-destructive/20 px-3 py-1.5 flex items-start gap-2"
      style={style}
      data-testid={`text-entity-error-${index}`}
    >
      <Badge variant="outline" className="shrink-0 mt-0.5 font-mono">
        {label}
      </Badge>
      <p className="text-sm text-muted-foreground line-clamp-2" title={err.message}>
        {err.message}
      </p>
    </div>
  );
}

interface EntityErrorGroup {
  kind: EntitySnapshotErrorKind;
  label: string;
  errors: EntitySnapshotError[];
}

function groupEntityErrors(errors: EntitySnapshotError[]): EntityErrorGroup[] {
  const groups = new Map<EntitySnapshotErrorKind, EntitySnapshotError[]>();
  for (const err of errors) {
    const existing = groups.get(err.kind);
    if (existing) {
      existing.push(err);
    } else {
      groups.set(err.kind, [err]);
    }
  }
  return Array.from(groups.entries())
    .map(([kind, errs]) => ({ kind, label: ENTITY_ERROR_KIND_LABELS[kind], errors: errs }))
    .sort((a, b) => b.errors.length - a.errors.length);
}

const TRIAGE_STORAGE_KEY = "kyutxo.entity-error-triage";

function loadTriageFromStorage(): Map<string, Record<string, boolean>> {
  try {
    const raw = localStorage.getItem(TRIAGE_STORAGE_KEY);
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as Record<string, Record<string, boolean>>;
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

function saveTriageToStorage(map: Map<string, Record<string, boolean>>): void {
  try {
    const obj: Record<string, Record<string, boolean>> = {};
    map.forEach((v, k) => {
      obj[k] = v;
    });
    localStorage.setItem(TRIAGE_STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // Ignore write failures (private browsing, storage quota, etc.)
  }
}

const entityErrorOpenStateBySignature = loadTriageFromStorage();

export function resetEntityErrorOpenState() {
  entityErrorOpenStateBySignature.clear();
  try {
    localStorage.removeItem(TRIAGE_STORAGE_KEY);
  } catch {
    // Ignore
  }
}

function entityErrorsSignature(errors: EntitySnapshotError[]): string {
  let hash = 5381;
  for (const err of errors) {
    const s = `${err.kind}\u0000${err.index}\u0000${err.message}`;
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) + hash) ^ s.charCodeAt(i);
    }
  }
  return `${errors.length}:${(hash >>> 0).toString(36)}`;
}

export function EntityErrorList({ errors }: { errors: EntitySnapshotError[] }) {
  const allGroups = useMemo(() => groupEntityErrors(errors), [errors]);
  const [kindFilter, setKindFilter] = useState<EntitySnapshotErrorKind | "all">("all");
  const [query, setQuery] = useState("");

  const trimmed = query.trim();
  const entryNumber = /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : null;
  const lowerQuery = trimmed.toLowerCase();
  const filterActive = trimmed.length > 0 || kindFilter !== "all";

  const groups = useMemo(() => {
    return allGroups
      .filter((group) => kindFilter === "all" || group.kind === kindFilter)
      .map((group) => {
        if (!trimmed) return group;
        const matched = group.errors.filter((err) =>
          entryNumber !== null
            ? err.index + 1 === entryNumber
            : err.message.toLowerCase().includes(lowerQuery),
        );
        return { ...group, errors: matched };
      })
      .filter((group) => group.errors.length > 0);
  }, [allGroups, kindFilter, trimmed, entryNumber, lowerQuery]);

  const totalMatches = useMemo(
    () => groups.reduce((sum, group) => sum + group.errors.length, 0),
    [groups],
  );
  const autoOpen = filterActive || groups.length === 1;

  const signature = useMemo(() => entityErrorsSignature(errors), [errors]);

  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  const userSetOpenRef = useRef<Record<string, boolean>>({});
  const loadedSignatureRef = useRef<string | null>(null);
  if (loadedSignatureRef.current !== signature) {
    loadedSignatureRef.current = signature;
    userSetOpenRef.current = { ...(entityErrorOpenStateBySignature.get(signature) ?? {}) };
  }
  useEffect(() => {
    setOpenMap((prev) => {
      const next: Record<string, boolean> = { ...prev };
      for (const group of allGroups) {
        next[group.kind] = autoOpen
          ? true
          : userSetOpenRef.current[group.kind] === true;
      }
      return next;
    });
  }, [autoOpen, allGroups]);
  const toggleGroup = (kind: string) => {
    const next = !openMap[kind];
    userSetOpenRef.current = { ...userSetOpenRef.current, [kind]: next };
    entityErrorOpenStateBySignature.set(signature, { ...userSetOpenRef.current });
    saveTriageToStorage(entityErrorOpenStateBySignature);
    setOpenMap((prev) => ({ ...prev, [kind]: next }));
  };

  return (
    <div className="space-y-2" data-testid="list-entity-errors">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[12rem]">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to entry # or filter by reason…"
            className="pl-8"
            data-testid="input-entity-error-filter"
          />
        </div>
        <Select
          value={kindFilter}
          onValueChange={(value) => setKindFilter(value as EntitySnapshotErrorKind | "all")}
        >
          <SelectTrigger className="w-[12rem]" data-testid="select-entity-error-kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All problem types</SelectItem>
            {allGroups.map((group) => (
              <SelectItem key={group.kind} value={group.kind}>
                {group.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {filterActive && (
        <p className="text-sm text-muted-foreground" data-testid="text-entity-error-match-count">
          {totalMatches === 0
            ? "No matching entries."
            : `${totalMatches.toLocaleString()} matching ${totalMatches === 1 ? "entry" : "entries"}.`}
        </p>
      )}
      {groups.map((group) => (
        <EntityErrorGroupItem
          key={group.kind}
          group={group}
          open={openMap[group.kind] ?? autoOpen}
          onToggle={() => toggleGroup(group.kind)}
        />
      ))}
    </div>
  );
}

function EntityErrorGroupItem({
  group,
  open,
  onToggle,
}: {
  group: EntityErrorGroup;
  open: boolean;
  onToggle: () => void;
}) {
  const { toast } = useToast();
  const count = group.errors.length;

  const entriesWithRaw = group.errors.filter((err) => "rawEntry" in err);
  const handleCopy = async (what: "numbers" | "details" | "json") => {
    let text: string;
    if (what === "numbers") {
      text = group.errors.map((err) => entityErrorLabel(err)).join("\n");
    } else if (what === "details") {
      text = group.errors.map((err) => `${entityErrorLabel(err)}: ${err.message}`).join("\n");
    } else {
      text = JSON.stringify(entriesWithRaw.map((err) => err.rawEntry), null, 2);
    }
    const ok = await copyTextToClipboard(text);
    const jsonCount = entriesWithRaw.length;
    toast({
      title: ok ? "Copied to clipboard" : "Copy failed",
      description: ok
        ? what === "numbers"
          ? `${count.toLocaleString()} entry ${count === 1 ? "number" : "numbers"} copied — paste to search your source file.`
          : what === "details"
            ? `${count.toLocaleString()} ${count === 1 ? "entry" : "entries"} with reasons copied.`
            : `${jsonCount.toLocaleString()} ${jsonCount === 1 ? "entry" : "entries"} copied as JSON.`
        : "Couldn't access the clipboard. Try selecting the text manually.",
      variant: ok ? undefined : "destructive",
    });
  };

  const handleDownload = () => {
    const text = JSON.stringify(entriesWithRaw.map((err) => err.rawEntry), null, 2);
    const blob = new Blob([text], { type: "application/json" });
    downloadBlob(blob, `entity-import-errors-${group.kind}.json`);
    const jsonCount = entriesWithRaw.length;
    toast({
      title: "Download started",
      description: `${jsonCount.toLocaleString()} ${jsonCount === 1 ? "entry" : "entries"} saved as JSON.`,
    });
  };

  return (
    <div
      className="rounded-md border border-destructive/40 overflow-hidden"
      data-testid={`group-entity-error-${group.kind}`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover-elevate"
        aria-expanded={open}
        data-testid={`button-entity-error-group-${group.kind}`}
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className="text-sm font-medium flex-1">{group.label}</span>
        <Badge variant="secondary" className="shrink-0" data-testid={`badge-entity-error-count-${group.kind}`}>
          {count.toLocaleString()}
        </Badge>
      </button>
      {open && (
        <div className="border-t border-destructive/40">
          <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-destructive/40">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => handleCopy("numbers")}
              data-testid={`button-copy-entity-error-numbers-${group.kind}`}
            >
              <Copy className="h-4 w-4" />
              Copy entry numbers
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => handleCopy("details")}
              data-testid={`button-copy-entity-error-details-${group.kind}`}
            >
              <Copy className="h-4 w-4" />
              Copy entries with reasons
            </Button>
            {entriesWithRaw.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => handleCopy("json")}
                data-testid={`button-copy-entity-error-json-${group.kind}`}
              >
                <Copy className="h-4 w-4" />
                Copy entries (JSON)
              </Button>
            )}
            {entriesWithRaw.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleDownload}
                data-testid={`button-download-entity-error-json-${group.kind}`}
              >
                <Download className="h-4 w-4" />
                Download entries (JSON)
              </Button>
            )}
          </div>
          {count <= ENTITY_ERROR_VIRTUALIZE_THRESHOLD ? (
            <div className="max-h-64 overflow-y-auto">
              {group.errors.map((err, i) => (
                <EntityErrorRow key={i} err={err} index={i} />
              ))}
            </div>
          ) : (
            <VirtualizedEntityErrorList errors={group.errors} />
          )}
        </div>
      )}
    </div>
  );
}

export function VirtualizedEntityErrorList({ errors }: { errors: EntitySnapshotError[] }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: errors.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ENTITY_ERROR_ROW_HEIGHT,
    overscan: 10,
  });

  return (
    <div ref={parentRef} className="max-h-64 overflow-y-auto">
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => (
          <EntityErrorRow
            key={virtualRow.key}
            err={errors[virtualRow.index]}
            index={virtualRow.index}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: "100%",
              height: `${virtualRow.size}px`,
              transform: `translateY(${virtualRow.start}px)`,
            }}
          />
        ))}
      </div>
    </div>
  );
}
