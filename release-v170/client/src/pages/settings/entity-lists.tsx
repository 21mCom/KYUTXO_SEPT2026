import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ENTITY_CATEGORY_LABELS, type EntityEntry, type EntityCategory } from "@/lib/privacy-entity-list";
import type { EntityChange, EntityOverride } from "@/lib/data/entity-list-store";
import { renderSourceNote } from "@/lib/renderSourceNote";

export const ENTITY_DIFF_ROW_HEIGHT = 52;
export const ENTITY_OVERRIDE_ROW_HEIGHT = 60;

export function EntityDiffList({
  entries,
  emptyLabel,
  variant,
}: {
  entries: EntityEntry[];
  emptyLabel: string;
  variant: "added" | "removed";
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ENTITY_DIFF_ROW_HEIGHT,
    overscan: 8,
  });

  if (entries.length === 0) {
    return (
      <p
        className="text-sm text-muted-foreground px-3 py-6 text-center"
        data-testid={`text-entity-diff-empty-${variant}`}
      >
        {emptyLabel}
      </p>
    );
  }

  return (
    <div
      ref={parentRef}
      className="max-h-64 overflow-y-auto rounded-md border"
      data-testid={`list-entity-diff-${variant}`}
    >
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const entry = entries[virtualRow.index];
          return (
            <div
              key={virtualRow.key}
              className="absolute left-0 top-0 w-full border-b px-3 py-1.5 flex items-center justify-between gap-3"
              style={{
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
              data-testid={`row-entity-diff-${variant}-${virtualRow.index}`}
            >
              <div className="min-w-0">
                <p className="text-sm font-medium truncate" data-testid={`text-entity-diff-name-${variant}-${virtualRow.index}`}>
                  {entry.name}
                </p>
                <p className="text-xs font-mono text-muted-foreground truncate">{entry.address}</p>
              </div>
              <Badge variant="secondary" className="shrink-0">
                {ENTITY_CATEGORY_LABELS[entry.category]}
              </Badge>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ChangedEntityList({
  changes,
  emptyLabel,
}: {
  changes: EntityChange[];
  emptyLabel: string;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: changes.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ENTITY_DIFF_ROW_HEIGHT,
    overscan: 8,
  });

  if (changes.length === 0) {
    return (
      <p
        className="text-sm text-muted-foreground px-3 py-6 text-center"
        data-testid="text-entity-diff-empty-changed"
      >
        {emptyLabel}
      </p>
    );
  }

  return (
    <div
      ref={parentRef}
      className="max-h-64 overflow-y-auto rounded-md border"
      data-testid="list-entity-diff-changed"
    >
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const change = changes[virtualRow.index];
          return (
            <div
              key={virtualRow.key}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              className="absolute left-0 top-0 w-full border-b px-3 py-1.5"
              style={{
                transform: `translateY(${virtualRow.start}px)`,
              }}
              data-testid={`row-entity-diff-changed-${virtualRow.index}`}
            >
              <div className="flex items-center justify-between gap-3 min-w-0">
                <div className="min-w-0">
                  {change.nameChanged ? (
                    <p className="text-sm truncate" data-testid={`text-entity-diff-name-changed-${virtualRow.index}`}>
                      <span className="line-through text-muted-foreground">{change.current.name}</span>
                      <span className="mx-1 text-muted-foreground">→</span>
                      <span className="font-medium">{change.incoming.name}</span>
                    </p>
                  ) : (
                    <p className="text-sm font-medium truncate" data-testid={`text-entity-diff-name-changed-${virtualRow.index}`}>
                      {change.incoming.name}
                    </p>
                  )}
                  <p className="text-xs font-mono text-muted-foreground truncate">{change.address}</p>
                </div>
                {change.categoryChanged ? (
                  <span className="flex items-center gap-1 shrink-0">
                    <Badge variant="outline" className="line-through opacity-70">
                      {ENTITY_CATEGORY_LABELS[change.current.category]}
                    </Badge>
                    <span className="text-muted-foreground">→</span>
                    <Badge variant="secondary">
                      {ENTITY_CATEGORY_LABELS[change.incoming.category]}
                    </Badge>
                  </span>
                ) : (
                  <Badge variant="secondary" className="shrink-0">
                    {ENTITY_CATEGORY_LABELS[change.incoming.category]}
                  </Badge>
                )}
              </div>
              {change.sourceNoteChanged && (
                <p
                  className="mt-1 text-xs text-muted-foreground min-w-0"
                  data-testid={`text-entity-diff-sourcenote-changed-${virtualRow.index}`}
                >
                  <span className="mr-1 font-medium">Source:</span>
                  <span className="line-through break-words">
                    {change.current.sourceNote ? renderSourceNote(change.current.sourceNote) : "(none)"}
                  </span>
                  <span className="mx-1">→</span>
                  <span className="text-foreground break-words">
                    {change.incoming.sourceNote ? renderSourceNote(change.incoming.sourceNote) : "(none)"}
                  </span>
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function EntityOverrideList({
  overrides,
  emptyLabel,
}: {
  overrides: EntityOverride[];
  emptyLabel: string;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: overrides.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ENTITY_OVERRIDE_ROW_HEIGHT,
    overscan: 8,
  });

  if (overrides.length === 0) {
    return (
      <p
        className="text-sm text-muted-foreground px-3 py-6 text-center"
        data-testid="text-entity-overrides-empty"
      >
        {emptyLabel}
      </p>
    );
  }

  return (
    <div
      ref={parentRef}
      className="max-h-64 overflow-y-auto rounded-md border"
      data-testid="list-entity-overrides"
    >
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const { previous, incoming, changed } = overrides[virtualRow.index];
          const sourceNoteChanged =
            (previous.sourceNote ?? "") !== (incoming.sourceNote ?? "");
          return (
            <div
              key={virtualRow.key}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              className="absolute left-0 top-0 w-full border-b px-3 py-1.5 space-y-1"
              style={{
                transform: `translateY(${virtualRow.start}px)`,
              }}
              data-testid={`row-entity-override-${virtualRow.index}`}
            >
              <p className="text-xs font-mono text-muted-foreground truncate">{previous.address}</p>
              <div className="flex items-center gap-2 text-sm min-w-0">
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className="truncate text-muted-foreground line-through" title={previous.name}>
                    {previous.name}
                  </span>
                  <Badge variant="outline" className="shrink-0">
                    {ENTITY_CATEGORY_LABELS[previous.category]}
                  </Badge>
                </span>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className="truncate font-medium" title={incoming.name}>
                    {incoming.name}
                  </span>
                  <Badge variant="secondary" className="shrink-0">
                    {ENTITY_CATEGORY_LABELS[incoming.category]}
                  </Badge>
                </span>
                {!changed && (
                  <Badge variant="outline" className="shrink-0">
                    no change
                  </Badge>
                )}
              </div>
              {sourceNoteChanged && (
                <p
                  className="text-xs text-muted-foreground min-w-0"
                  data-testid={`text-entity-override-sourcenote-${virtualRow.index}`}
                >
                  <span className="mr-1 font-medium">Source:</span>
                  <span className="line-through break-words">
                    {previous.sourceNote ? renderSourceNote(previous.sourceNote) : "(none)"}
                  </span>
                  <span className="mx-1">→</span>
                  <span className="text-foreground break-words">
                    {incoming.sourceNote ? renderSourceNote(incoming.sourceNote) : "(none)"}
                  </span>
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
