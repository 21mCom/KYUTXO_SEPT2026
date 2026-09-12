import { useState, useEffect, useRef } from "react";
import { Link } from "wouter";
import { GitBranch, ExternalLink, Loader2, ChevronDown, ChevronUp } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ScrollPositionIndicator } from "@/components/ScrollPositionIndicator";
import type { Record } from "@/lib/database";
import { getRecordsByDiscoveredFromIds } from "@/lib/data/record-crud";

const PREVIEW_COUNT = 4;
const ROW_HEIGHT = 36;
const MAX_VIRTUAL_HEIGHT = 300;

interface DiscoveryTreeDialogProps {
  open: boolean;
  onClose: () => void;
  parentRecordId: number;
  parentAddress: string;
}

interface DiscoveredRecord extends Record {
  discoveryDepth: number;
}

async function fetchDiscoveryTree(parentRecordId: number): Promise<DiscoveredRecord[]> {
  const allDiscovered: DiscoveredRecord[] = [];
  let currentParentIds = [parentRecordId];
  let depth = 1;

  while (currentParentIds.length > 0) {
    // The repository query is bounded and works for both protected and Dexie
    // stores; do not open the legacy IndexedDB table in packaged Electron.
    const children: Record[] = await getRecordsByDiscoveredFromIds(currentParentIds);

    if (children.length === 0) break;

    const withDepth: DiscoveredRecord[] = children.map((r) => ({
      ...r,
      discoveryDepth: depth,
    }));
    for (const item of withDepth) allDiscovered.push(item);

    currentParentIds = withDepth
      .map((r) => r.id)
      .filter((id): id is number => id !== undefined);
    depth++;

    if (depth > 50) break;
  }

  return allDiscovered;
}

function truncate(str: string, len: number) {
  if (str.length <= len) return str;
  return str.slice(0, len) + "...";
}

function RecordRow({ rec }: { rec: DiscoveredRecord }) {
  return (
    <div
      className="flex items-center gap-2 py-1"
      data-testid={`record-row-${rec.id}`}
    >
      <Badge
        variant={rec.type === "address" ? "default" : "secondary"}
        data-testid={`badge-type-${rec.id}`}
      >
        {rec.type === "address" ? "Addr" : "Tx"}
      </Badge>
      <span
        className="font-mono text-sm truncate flex-1 min-w-0"
        data-testid={`text-input-${rec.id}`}
      >
        {truncate(rec.inputString, 32)}
      </span>
      {rec.syncDepth !== undefined && (
        <Badge variant="outline" data-testid={`badge-depth-${rec.id}`}>
          D{rec.syncDepth}
        </Badge>
      )}
      <Link href={`/records?id=${rec.id}`}>
        <Button size="icon" variant="ghost" data-testid={`link-view-${rec.id}`}>
          <ExternalLink className="h-4 w-4" />
        </Button>
      </Link>
    </div>
  );
}

function VirtualizedRecordList({ records }: { records: DiscoveredRecord[] }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualHeight = Math.min(records.length * ROW_HEIGHT, MAX_VIRTUAL_HEIGHT);

  const virtualizer = useVirtualizer({
    count: records.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  return (
    <div
      ref={parentRef}
      className="overflow-y-auto"
      style={{ height: virtualHeight }}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => (
          <div
            key={virtualItem.key}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: `${virtualItem.size}px`,
              transform: `translateY(${virtualItem.start}px)`,
            }}
          >
            <RecordRow rec={records[virtualItem.index]} />
          </div>
        ))}
      </div>
      <ScrollPositionIndicator
        virtualItems={virtualizer.getVirtualItems()}
        totalCount={records.length}
        scrollElement={parentRef.current}
        label="records"
        variant="compact"
      />
    </div>
  );
}

function DepthGroup({
  depth,
  records,
}: {
  depth: number;
  records: DiscoveredRecord[];
}) {
  const [expanded, setExpanded] = useState(false);
  const needsExpand = records.length > PREVIEW_COUNT;
  const previewRecords = records.slice(0, PREVIEW_COUNT);
  const remaining = records.length - PREVIEW_COUNT;

  return (
    <div data-testid={`depth-group-${depth}`}>
      <h4 className="text-xs font-medium text-muted-foreground mb-2">
        Depth {depth}
        <span className="ml-1.5 text-muted-foreground/60">
          ({records.length})
        </span>
      </h4>

      {!expanded ? (
        <div className="space-y-0">
          {previewRecords.map((rec) => (
            <RecordRow key={rec.id} rec={rec} />
          ))}
          {needsExpand && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpanded(true)}
              className="w-full mt-1 text-muted-foreground"
              data-testid={`button-expand-depth-${depth}`}
            >
              <ChevronDown className="mr-1.5" />
              Show {remaining} more
            </Button>
          )}
        </div>
      ) : (
        <div>
          <VirtualizedRecordList records={records} />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded(false)}
            className="w-full mt-1 text-muted-foreground"
            data-testid={`button-collapse-depth-${depth}`}
          >
            <ChevronUp className="mr-1.5" />
            Show fewer
          </Button>
        </div>
      )}
    </div>
  );
}

export default function DiscoveryTreeDialog({
  open,
  onClose,
  parentRecordId,
  parentAddress,
}: DiscoveryTreeDialogProps) {
  const [loading, setLoading] = useState(false);
  const [records, setRecords] = useState<DiscoveredRecord[]>([]);

  useEffect(() => {
    if (!open) {
      setRecords([]);
      return;
    }

    let cancelled = false;
    setLoading(true);

    fetchDiscoveryTree(parentRecordId)
      .then((result) => {
        if (!cancelled) setRecords(result);
      })
      .catch((err) => {
        console.error("Failed to fetch discovery tree:", err);
        if (!cancelled) setRecords([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, parentRecordId]);

  const addressCount = records.filter((r) => r.type === "address").length;
  const txCount = records.filter((r) => r.type === "transaction").length;

  const depthGroups = new Map<number, DiscoveredRecord[]>();
  for (const rec of records) {
    const group = depthGroups.get(rec.discoveryDepth) || [];
    group.push(rec);
    depthGroups.set(rec.discoveryDepth, group);
  }
  const sortedDepths = Array.from(depthGroups.keys()).sort((a, b) => a - b);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-lg" data-testid="dialog-discovery-tree">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2" data-testid="title-discovery-tree">
            <GitBranch className="h-5 w-5" />
            Discovery Tree
          </DialogTitle>
          <p className="text-sm text-muted-foreground font-mono" data-testid="text-parent-address">
            {truncate(parentAddress, 24)}
          </p>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8" data-testid="loading-discovery-tree">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : records.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground" data-testid="empty-discovery-tree">
            No records were discovered from this address.
          </div>
        ) : (
          <>
            <div className="text-sm text-muted-foreground" data-testid="text-discovery-summary">
              {addressCount} address{addressCount !== 1 ? "es" : ""}, {txCount} transaction{txCount !== 1 ? "s" : ""} discovered
            </div>

            <ScrollArea className="max-h-[450px]">
              <div className="space-y-4 pr-3">
                {sortedDepths.map((depth) => (
                  <DepthGroup
                    key={depth}
                    depth={depth}
                    records={depthGroups.get(depth)!}
                  />
                ))}
              </div>
            </ScrollArea>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
