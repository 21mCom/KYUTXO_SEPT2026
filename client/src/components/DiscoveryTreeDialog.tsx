import { useState, useEffect } from "react";
import { Link } from "wouter";
import { GitBranch, ExternalLink, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { db } from "@/lib/database";
import type { Record } from "@/lib/database";
import { decryptRecords } from "@/lib/encryptionFacade";

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
    const children: Record[] = [];
    for (const pid of currentParentIds) {
      const batch = await db.records
        .filter((r) => r.discoveredFromRecordId === pid)
        .toArray();
      children.push(...batch);
    }

    if (children.length === 0) break;

    const decrypted = await decryptRecords(children);
    const withDepth: DiscoveredRecord[] = decrypted.map((r) => ({
      ...r,
      discoveryDepth: depth,
    }));
    allDiscovered.push(...withDepth);

    currentParentIds = decrypted
      .map((r) => r.id)
      .filter((id): id is number => id !== undefined);
    depth++;

    if (depth > 50) break;
  }

  return allDiscovered;
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

  function truncate(str: string, len: number) {
    if (str.length <= len) return str;
    return str.slice(0, len) + "...";
  }

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
              {addressCount} address{addressCount !== 1 ? "es" : ""}, {txCount} transaction{txCount !== 1 ? "s" : ""} discovered from this address
            </div>

            <ScrollArea className="max-h-[400px]">
              <div className="space-y-4">
                {sortedDepths.map((depth) => (
                  <div key={depth} data-testid={`depth-group-${depth}`}>
                    <h4 className="text-xs font-medium text-muted-foreground mb-2">
                      Depth {depth}
                    </h4>
                    <div className="space-y-1">
                      {depthGroups.get(depth)!.map((rec) => (
                        <div
                          key={rec.id}
                          className="flex items-center gap-2 py-1"
                          data-testid={`record-row-${rec.id}`}
                        >
                          <Badge
                            variant={rec.type === "address" ? "default" : "secondary"}
                            data-testid={`badge-type-${rec.id}`}
                          >
                            {rec.type === "address" ? "Address" : "Transaction"}
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
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
