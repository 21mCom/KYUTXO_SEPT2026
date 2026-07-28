import { useState, useEffect, useMemo, useRef } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { MoreVertical, ArrowUp, ArrowDown, ArrowUpDown, Settings2, Paperclip, Key, RefreshCw } from "lucide-react";
import { classifyBehavior, BEHAVIOR_LABEL_DISPLAY } from "@/lib/behavior-profile";
import { batchPreloadIdentifiers } from "@/lib/metadata-hover";
import { AddressLink } from "./AddressLink";
import { TxidLink } from "./TxidLink";
import { RecordTypeBadge } from "./RecordTypeBadge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useSettings, useCustomFields, toggleTableColumn, toggleCustomFieldColumn } from "@/hooks/use-settings";
import { db, type CustomField } from "@/lib/database";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBTC } from "@/lib/bitcoin";
import { formatAddedDate } from "@/lib/format-added-date";

type SortDirection = "asc" | "desc" | null;
type SortColumn = "type" | "label" | "inputString" | "tags" | "categories" | "walletSoftware" | "seedName" | "privateKeyStatus" | "attachments" | "source" | "owner" | "balance" | "lastTxDate" | "txCount" | string;

import type { BehaviorProfile } from "@/lib/behavior-profile";

interface AddressStats {
  balanceSats: number;
  lastTxDate: number;
  txCount: number;
  utxoCount: number;
  synced: boolean;
  behaviorProfile: BehaviorProfile;
}

// Format Unix timestamp (seconds) to human-readable date
function formatBlockTime(timestamp?: number): string {
  if (!timestamp) return "-";
  const date = new Date(timestamp * 1000);
  return date.toLocaleDateString('en-US', { 
    year: 'numeric', 
    month: 'short', 
    day: 'numeric' 
  });
}

// Format source field for display - strip timestamp suffixes
function formatSourceDisplay(source?: string): string {
  if (!source) return "-";
  
  // walletImport-Sparrow Wallet_2024-01-01_054834 -> Sparrow Wallet Import (2024-01-01)
  const walletImportMatch = source.match(/^walletImport-(.+?)_(\d{4}-\d{2}-\d{2})_\d+$/);
  if (walletImportMatch) {
    return `${walletImportMatch[1]} Import (${walletImportMatch[2]})`;
  }
  
  // Handle sources that might have multiple values separated by semicolons
  // Clean each part individually
  const parts = source.split('; ').map(part => {
    const partMatch = part.match(/^walletImport-(.+?)_(\d{4}-\d{2}-\d{2})_\d+$/);
    if (partMatch) {
      return `${partMatch[1]} (${partMatch[2]})`;
    }
    return part;
  });
  
  // Dedupe and join
  const unique = Array.from(new Set(parts));
  return unique.join('; ');
}

interface Record {
  id: string;
  type: "address" | "transaction" | "other";
  inputString: string;
  label: string;
  tags: string[];
  categories?: string[];
  walletSoftware?: string;
  seedName?: string;
  privateKeyStatus?: string;
  owner?: string;
  walletName?: string;
  source?: string;
  customFields?: { [key: string]: string };
  syncDepth?: number;
  maxSyncedDepth?: number;
  firstSeenBlockTime?: number;
  createdAt?: number;
  cachedBalanceSats?: number;
  cachedTxCount?: number;
  cachedLastActivityTime?: number;
  cachedUtxoCount?: number;
  statsComputedAt?: number;
}

interface RecordTableProps {
  records: Record[];
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
  onRowClick?: (id: string) => void;
  onSyncDeeper?: (id: string) => void;
  externalSortColumn?: SortColumn | null;
  externalSortDirection?: SortDirection;
  onSortChange?: (column: SortColumn) => void;
  selectionEnabled?: boolean;
  selectedIds?: Set<string>;
  onSelectionChange?: (selectedIds: Set<string>) => void;
  precomputedAddressStats?: Map<string, AddressStats>;
  statsLoading?: boolean;
  /** Show the "Added" (createdAt) column — enabled by the Records page when a
   *  Date Added sort/recency filter is active. */
  showAddedColumn?: boolean;
}

interface SortableHeaderProps {
  column: SortColumn;
  label: string;
  currentSort: SortColumn | null;
  direction: SortDirection;
  onSort: (column: SortColumn) => void;
  className?: string;
}

function SortableHeader({ column, label, currentSort, direction, onSort, className }: SortableHeaderProps) {
  const isActive = currentSort === column;
  
  return (
    <TableHead className={className}>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 gap-1 -ml-3"
        onClick={() => onSort(column)}
        data-testid={`button-sort-${column}`}
      >
        {label}
        {isActive && direction === "asc" ? (
          <ArrowUp className="h-3 w-3" />
        ) : isActive && direction === "desc" ? (
          <ArrowDown className="h-3 w-3" />
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-50" />
        )}
      </Button>
    </TableHead>
  );
}

export function RecordTable({ 
  records, 
  onEdit, 
  onDelete, 
  onRowClick, 
  onSyncDeeper,
  externalSortColumn,
  externalSortDirection,
  onSortChange,
  selectionEnabled = false,
  selectedIds = new Set(),
  onSelectionChange,
  precomputedAddressStats,
  statsLoading: externalStatsLoading,
  showAddedColumn = false,
}: RecordTableProps) {
  const { tableColumns, customFieldColumns } = useSettings();
  const { enabledCustomFields } = useCustomFields();
  const [attachmentCounts, setAttachmentCounts] = useState<Map<string, number>>(new Map());
  
  const [internalSortColumn, setInternalSortColumn] = useState<SortColumn | null>(null);
  const [internalSortDirection, setInternalSortDirection] = useState<SortDirection>(null);
  
  const isExternallyControlled = onSortChange !== undefined;
  const internalOnlyColumns = precomputedAddressStats ? ["attachments"] : ["attachments", "balance", "lastTxDate", "txCount"];
  const isInternalComputedSort = isExternallyControlled && internalOnlyColumns.includes(internalSortColumn || "");
  const sortColumn = isInternalComputedSort ? internalSortColumn : (isExternallyControlled ? (externalSortColumn ?? null) : internalSortColumn);
  const sortDirection = isInternalComputedSort ? internalSortDirection : (isExternallyControlled ? (externalSortDirection ?? null) : internalSortDirection);

  // Address stats are read directly from the per-record cache (computed locally
  // during sync / manual recompute). No participant scan or network access here.
  // behaviorProfile is derived deterministically from the same cached fields.
  const localAddressStats = useMemo(() => {
    const result = new Map<string, AddressStats>();
    for (const record of records) {
      if (record.type !== 'address' || !record.inputString || record.id == null) continue;
      const synced = record.statsComputedAt != null;
      const balanceSats = record.cachedBalanceSats ?? 0;
      const txCount = record.cachedTxCount ?? 0;
      const utxoCount = record.cachedUtxoCount ?? 0;
      const lastTxDate = record.cachedLastActivityTime ?? 0;
      result.set(String(record.id), {
        balanceSats,
        lastTxDate,
        txCount,
        utxoCount,
        synced,
        behaviorProfile: classifyBehavior({
          synced,
          balanceSats,
          txCount,
          utxoCount,
          lastActivityTime: lastTxDate,
        }),
      });
    }
    return result;
  }, [records]);
  // Use precomputedAddressStats only if non-empty; an empty Map (returned when
  // stats columns are toggled off in Dashboard) is truthy but useless — fall
  // back to localAddressStats so behavior badges always render.
  const addressStats = (precomputedAddressStats && precomputedAddressStats.size > 0)
    ? precomputedAddressStats
    : localAddressStats;

  // Preload metadata cache for every visible record so the note indicator
  // appears automatically without requiring a hover on each row.
  const prevPreloadIdsRef = useRef<string>('');
  useEffect(() => {
    if (records.length === 0) return;
    const ids = records.map(r => r.inputString).filter(Boolean);
    const key = ids.join(',');
    if (key === prevPreloadIdsRef.current) return;
    prevPreloadIdsRef.current = key;
    batchPreloadIdentifiers(ids);
  }, [records]);
  const statsLoading = precomputedAddressStats ? (externalStatsLoading ?? false) : false;

  useEffect(() => {
    const loadAttachmentCounts = async () => {
      const recordIds = records.map(r => Number(r.id));
      const attachments = await db.attachments
        .where('recordId')
        .anyOf(recordIds)
        .toArray();
      const counts = new Map<string, number>();
      for (const a of attachments) {
        const key = String(a.recordId);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      setAttachmentCounts(counts);
    };
    
    if (records.length > 0) {
      loadAttachmentCounts();
    }
  }, [records]);

  const handleSort = (column: SortColumn) => {
    // Attachments sorting requires attachment counts which are only available here
    // So always handle it internally even when externally controlled
    const sortInternalColumns = precomputedAddressStats ? ["attachments"] : ["attachments", "balance", "lastTxDate", "txCount"];
    const shouldHandleInternally = !isExternallyControlled || sortInternalColumns.includes(column);
    
    if (shouldHandleInternally) {
      // Internal sort logic
      if (internalSortColumn === column) {
        if (internalSortDirection === "asc") {
          setInternalSortDirection("desc");
        } else if (internalSortDirection === "desc") {
          setInternalSortColumn(null);
          setInternalSortDirection(null);
        } else {
          setInternalSortDirection("asc");
        }
      } else {
        setInternalSortColumn(column);
        setInternalSortDirection("asc");
      }
    } else {
      // Parent handles the sort logic for non-attachment columns
      onSortChange!(column);
    }
  };

  const sortedRecords = useMemo(() => {
    // When externally controlled, parent already sorted records
    // Exception: computed columns (attachments, balance, lastTxDate, txCount) are always internal
    if (isExternallyControlled && !internalOnlyColumns.includes(internalSortColumn || "")) {
      return records;
    }
    
    // Internal sorting - for non-external control or attachments column
    const activeColumn = isExternallyControlled ? internalSortColumn : sortColumn;
    const activeDirection = isExternallyControlled ? internalSortDirection : sortDirection;
    
    if (!activeColumn || !activeDirection) {
      return records;
    }

    return [...records].sort((a, b) => {
      let aVal: string | number = "";
      let bVal: string | number = "";

      switch (activeColumn) {
        case "type":
          aVal = a.type;
          bVal = b.type;
          break;
        case "label":
          aVal = a.label.toLowerCase();
          bVal = b.label.toLowerCase();
          break;
        case "inputString":
          aVal = a.inputString.toLowerCase();
          bVal = b.inputString.toLowerCase();
          break;
        case "tags":
          aVal = (a.tags[0] || "").toLowerCase();
          bVal = (b.tags[0] || "").toLowerCase();
          break;
        case "categories":
          aVal = ((a.categories || [])[0] || "").toLowerCase();
          bVal = ((b.categories || [])[0] || "").toLowerCase();
          break;
        case "walletSoftware":
          aVal = (a.walletSoftware || "").toLowerCase();
          bVal = (b.walletSoftware || "").toLowerCase();
          break;
        case "seedName":
          aVal = (a.seedName || "").toLowerCase();
          bVal = (b.seedName || "").toLowerCase();
          break;
        case "privateKeyStatus":
          aVal = (a.privateKeyStatus || "").toLowerCase();
          bVal = (b.privateKeyStatus || "").toLowerCase();
          break;
        case "attachments":
          aVal = attachmentCounts.get(a.id) || 0;
          bVal = attachmentCounts.get(b.id) || 0;
          break;
        case "balance":
          aVal = addressStats.get(a.id)?.balanceSats || 0;
          bVal = addressStats.get(b.id)?.balanceSats || 0;
          break;
        case "lastTxDate":
          aVal = addressStats.get(a.id)?.lastTxDate || 0;
          bVal = addressStats.get(b.id)?.lastTxDate || 0;
          break;
        case "txCount":
          aVal = addressStats.get(a.id)?.txCount || 0;
          bVal = addressStats.get(b.id)?.txCount || 0;
          break;
        case "source":
          aVal = (a.source || "").toLowerCase();
          bVal = (b.source || "").toLowerCase();
          break;
        case "owner":
          aVal = (a.owner || "").toLowerCase();
          bVal = (b.owner || "").toLowerCase();
          break;
        case "walletName":
          aVal = (a.walletName || "").toLowerCase();
          bVal = (b.walletName || "").toLowerCase();
          break;
        case "firstSeen":
          aVal = a.firstSeenBlockTime || 0;
          bVal = b.firstSeenBlockTime || 0;
          break;
        default:
          if (activeColumn.startsWith("custom_")) {
            const fieldSlug = activeColumn.replace("custom_", "");
            aVal = (a.customFields?.[fieldSlug] || "").toLowerCase();
            bVal = (b.customFields?.[fieldSlug] || "").toLowerCase();
          }
      }

      if (aVal < bVal) return activeDirection === "asc" ? -1 : 1;
      if (aVal > bVal) return activeDirection === "asc" ? 1 : -1;
      return 0;
    });
  }, [records, sortColumn, sortDirection, attachmentCounts, addressStats, isExternallyControlled, internalSortColumn, internalSortDirection]);

  const getPrivateKeyBadge = (status?: string) => {
    if (!status) return null;
    switch (status.toLowerCase()) {
      case 'yes':
        return <Badge variant="default" className="text-xs bg-green-600">Yes</Badge>;
      case 'no':
        return <Badge variant="secondary" className="text-xs">No</Badge>;
      case 'unsure':
        return <Badge variant="outline" className="text-xs">Unsure</Badge>;
      default:
        return <Badge variant="outline" className="text-xs">{status}</Badge>;
    }
  };

  // Selection helpers
  const allSelected = selectionEnabled && sortedRecords.length > 0 && sortedRecords.every(r => selectedIds.has(r.id));
  const someSelected = selectionEnabled && sortedRecords.some(r => selectedIds.has(r.id));
  
  const handleSelectAll = (checked: boolean) => {
    if (!onSelectionChange) return;
    if (!checked) {
      // Deselect all visible records
      const newSelected = new Set(selectedIds);
      sortedRecords.forEach(r => newSelected.delete(r.id));
      onSelectionChange(newSelected);
    } else {
      // Select all visible records
      const newSelected = new Set(selectedIds);
      sortedRecords.forEach(r => newSelected.add(r.id));
      onSelectionChange(newSelected);
    }
  };

  const handleSelectRow = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onSelectionChange) return;
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    onSelectionChange(newSelected);
  };

  return (
    <div className="border rounded-lg">
      <Table>
        <TableHeader>
          <TableRow>
            {selectionEnabled && (
              <TableHead className="w-[40px]">
                <Checkbox
                  checked={allSelected ? true : (someSelected ? "indeterminate" : false)}
                  onCheckedChange={(checked) => handleSelectAll(checked === true)}
                  onClick={(e) => e.stopPropagation()}
                  data-testid="checkbox-select-all"
                />
              </TableHead>
            )}
            <SortableHeader
              column="type"
              label="Type"
              currentSort={sortColumn}
              direction={sortDirection}
              onSort={handleSort}
              className="w-[100px]"
            />
            <SortableHeader
              column="label"
              label="Label"
              currentSort={sortColumn}
              direction={sortDirection}
              onSort={handleSort}
            />
            <SortableHeader
              column="inputString"
              label="Address / TXID"
              currentSort={sortColumn}
              direction={sortDirection}
              onSort={handleSort}
            />
            {tableColumns.tags && (
              <SortableHeader
                column="tags"
                label="Tags"
                currentSort={sortColumn}
                direction={sortDirection}
                onSort={handleSort}
              />
            )}
            {tableColumns.categories && (
              <SortableHeader
                column="categories"
                label="Categories"
                currentSort={sortColumn}
                direction={sortDirection}
                onSort={handleSort}
              />
            )}
            {tableColumns.walletSoftware && (
              <SortableHeader
                column="walletSoftware"
                label="Wallet"
                currentSort={sortColumn}
                direction={sortDirection}
                onSort={handleSort}
              />
            )}
            {tableColumns.seedName && (
              <SortableHeader
                column="seedName"
                label="Seed"
                currentSort={sortColumn}
                direction={sortDirection}
                onSort={handleSort}
              />
            )}
            {tableColumns.privateKeyStatus && (
              <SortableHeader
                column="privateKeyStatus"
                label="Private Key"
                currentSort={sortColumn}
                direction={sortDirection}
                onSort={handleSort}
              />
            )}
            {tableColumns.hasAttachments && (
              <SortableHeader
                column="attachments"
                label="Files"
                currentSort={sortColumn}
                direction={sortDirection}
                onSort={handleSort}
                className="w-[50px]"
              />
            )}
            {tableColumns.source && (
              <SortableHeader
                column="source"
                label="Source"
                currentSort={sortColumn}
                direction={sortDirection}
                onSort={handleSort}
              />
            )}
            {tableColumns.owner && (
              <SortableHeader
                column="owner"
                label="Owner"
                currentSort={sortColumn}
                direction={sortDirection}
                onSort={handleSort}
              />
            )}
            {tableColumns.walletName && (
              <SortableHeader
                column="walletName"
                label="Wallet Name"
                currentSort={sortColumn}
                direction={sortDirection}
                onSort={handleSort}
              />
            )}
            {tableColumns.firstSeen && (
              <SortableHeader
                column="firstSeen"
                label="First Seen"
                currentSort={sortColumn}
                direction={sortDirection}
                onSort={handleSort}
              />
            )}
            {showAddedColumn && (
              <TableHead data-testid="header-added">Added</TableHead>
            )}
            {tableColumns.balance && (
              <SortableHeader
                column="balance"
                label="BTC Balance"
                currentSort={sortColumn}
                direction={sortDirection}
                onSort={handleSort}
              />
            )}
            {tableColumns.lastTxDate && (
              <SortableHeader
                column="lastTxDate"
                label="Last Tx Date"
                currentSort={sortColumn}
                direction={sortDirection}
                onSort={handleSort}
              />
            )}
            {tableColumns.txCount && (
              <SortableHeader
                column="txCount"
                label="Tx Count"
                currentSort={sortColumn}
                direction={sortDirection}
                onSort={handleSort}
              />
            )}
            {enabledCustomFields.filter(f => customFieldColumns[f.slug]).map((field) => (
              <SortableHeader
                key={field.slug}
                column={`custom_${field.slug}`}
                label={field.name}
                currentSort={sortColumn}
                direction={sortDirection}
                onSort={handleSort}
              />
            ))}
            <TableHead className="w-[50px]"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {records.length === 0 ? (
            <TableRow>
              <TableCell 
                colSpan={5 + 
                  (selectionEnabled ? 1 : 0) +
                  (tableColumns.tags ? 1 : 0) + 
                  (tableColumns.categories ? 1 : 0) + 
                  (tableColumns.walletSoftware ? 1 : 0) + 
                  (tableColumns.seedName ? 1 : 0) + 
                  (tableColumns.privateKeyStatus ? 1 : 0) + 
                  (tableColumns.hasAttachments ? 1 : 0) +
                  (tableColumns.source ? 1 : 0) +
                  (tableColumns.owner ? 1 : 0) +
                  (tableColumns.walletName ? 1 : 0) +
                  (tableColumns.firstSeen ? 1 : 0) +
                  (showAddedColumn ? 1 : 0) +
                  enabledCustomFields.filter(f => customFieldColumns[f.slug]).length
                } 
                className="h-24 text-center text-muted-foreground"
              >
                No records found. Create your first record to get started.
              </TableCell>
            </TableRow>
          ) : (
            sortedRecords.map((record) => (
              <TableRow
                key={record.id}
                className={`cursor-pointer hover-elevate ${selectedIds.has(record.id) ? 'bg-muted/50' : ''}`}
                onClick={() => onRowClick?.(record.id)}
                data-testid={`row-record-${record.id}`}
              >
                {selectionEnabled && (
                  <TableCell>
                    <Checkbox
                      checked={selectedIds.has(record.id)}
                      onClick={(e) => handleSelectRow(record.id, e)}
                      data-testid={`checkbox-select-${record.id}`}
                    />
                  </TableCell>
                )}
                <TableCell>
                  <RecordTypeBadge type={record.type} />
                </TableCell>
                <TableCell data-testid={`text-label-${record.id}`}>
                  <div className="flex flex-col gap-1">
                    <span className="font-medium">{record.label}</span>
                    {record.type === 'address' && (() => {
                      const bp = addressStats.get(record.id)?.behaviorProfile;
                      if (!bp) return null;
                      return (
                        <Badge
                          variant={bp.label === 'not-enough-data' ? 'outline' : 'secondary'}
                          className={`text-xs w-fit${bp.label === 'synced-no-activity' ? ' opacity-70' : ''}`}
                          title={bp.summarySentence}
                          data-testid={`badge-behavior-${record.id}`}
                        >
                          {BEHAVIOR_LABEL_DISPLAY[bp.label]}
                        </Badge>
                      );
                    })()}
                  </div>
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  {record.type === 'transaction' ? (
                    <TxidLink
                      txid={record.inputString}
                      recordId={Number(record.id)}
                    />
                  ) : (
                    <AddressLink
                      address={record.inputString}
                      recordId={Number(record.id)}
                    />
                  )}
                </TableCell>
                {tableColumns.tags && (
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {(record.tags ?? []).slice(0, 2).map((tag) => (
                        <Badge key={tag} variant="outline" className="text-xs">
                          {tag}
                        </Badge>
                      ))}
                      {(record.tags ?? []).length > 2 && (
                        <Badge variant="outline" className="text-xs">
                          +{(record.tags ?? []).length - 2}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                )}
                {tableColumns.categories && (
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {(record.categories || []).slice(0, 2).map((cat) => (
                        <Badge key={cat} variant="secondary" className="text-xs">
                          {cat}
                        </Badge>
                      ))}
                      {(record.categories || []).length > 2 && (
                        <Badge variant="secondary" className="text-xs">
                          +{(record.categories || []).length - 2}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                )}
                {tableColumns.walletSoftware && (
                  <TableCell className="text-sm text-muted-foreground">
                    {record.walletSoftware || "-"}
                  </TableCell>
                )}
                {tableColumns.seedName && (
                  <TableCell className="text-sm text-muted-foreground">
                    {record.seedName || "-"}
                  </TableCell>
                )}
                {tableColumns.privateKeyStatus && (
                  <TableCell>
                    {getPrivateKeyBadge(record.privateKeyStatus)}
                  </TableCell>
                )}
                {tableColumns.hasAttachments && (
                  <TableCell>
                    {(attachmentCounts.get(record.id) || 0) > 0 && (
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <Paperclip className="h-3 w-3" />
                        <span className="text-xs">{attachmentCounts.get(record.id)}</span>
                      </div>
                    )}
                  </TableCell>
                )}
                {tableColumns.source && (
                  <TableCell className="text-sm text-muted-foreground">
                    {formatSourceDisplay(record.source)}
                  </TableCell>
                )}
                {tableColumns.owner && (
                  <TableCell className="text-sm text-muted-foreground">
                    {record.owner || "-"}
                  </TableCell>
                )}
                {tableColumns.walletName && (
                  <TableCell className="text-sm text-muted-foreground">
                    {record.walletName || "-"}
                  </TableCell>
                )}
                {tableColumns.firstSeen && (
                  <TableCell className="text-sm text-muted-foreground">
                    {formatBlockTime(record.firstSeenBlockTime)}
                  </TableCell>
                )}
                {showAddedColumn && (
                  <TableCell
                    className="text-sm text-muted-foreground whitespace-nowrap"
                    title={record.createdAt ? new Date(record.createdAt).toLocaleString() : undefined}
                    data-testid={`text-added-${record.id}`}
                  >
                    {formatAddedDate(record.createdAt)}
                  </TableCell>
                )}
                {tableColumns.balance && (
                  <TableCell className="text-sm text-right tabular-nums" data-testid={`text-balance-${record.id}`}>
                    {record.type === 'address'
                      ? statsLoading && !addressStats.has(record.id)
                        ? <Skeleton className="h-4 w-16 ml-auto" />
                        : !addressStats.get(record.id)?.synced
                          ? <span className="text-muted-foreground text-xs italic">Not synced</span>
                          : formatBTC(addressStats.get(record.id)!.balanceSats)
                      : <span className="text-muted-foreground">-</span>}
                  </TableCell>
                )}
                {tableColumns.lastTxDate && (
                  <TableCell className="text-sm text-muted-foreground">
                    {record.type === 'address'
                      ? statsLoading && !addressStats.has(record.id)
                        ? <Skeleton className="h-4 w-24" />
                        : !addressStats.get(record.id)?.synced
                          ? <span className="text-xs italic">Not synced</span>
                          : addressStats.get(record.id)!.lastTxDate > 0
                            ? formatBlockTime(addressStats.get(record.id)!.lastTxDate)
                            : "-"
                      : "-"}
                  </TableCell>
                )}
                {tableColumns.txCount && (
                  <TableCell className="text-sm text-right tabular-nums">
                    {record.type === 'address'
                      ? statsLoading && !addressStats.has(record.id)
                        ? <Skeleton className="h-4 w-10 ml-auto" />
                        : !addressStats.get(record.id)?.synced
                          ? <span className="text-muted-foreground text-xs italic">Not synced</span>
                          : addressStats.get(record.id)!.txCount
                      : <span className="text-muted-foreground">-</span>}
                  </TableCell>
                )}
                {enabledCustomFields.filter(f => customFieldColumns[f.slug]).map((field) => {
                  const value = record.customFields?.[field.slug];
                  const displayValue = value || "-";
                  return (
                    <TableCell key={field.slug} className="text-sm text-muted-foreground">
                      {displayValue}
                    </TableCell>
                  );
                })}
                <TableCell>
                  <div className="flex items-center gap-2 justify-end">
                    {record.type === 'address' && record.syncDepth !== undefined && (
                      <Badge 
                        variant={record.syncDepth === 0 ? "default" : "secondary"} 
                        className="text-xs"
                        title={`Sync depth: ${record.syncDepth}${record.maxSyncedDepth !== undefined ? `, synced to: ${record.maxSyncedDepth}` : ''}`}
                      >
                        D{record.syncDepth}
                      </Badge>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                        <Button size="icon" variant="ghost" data-testid={`button-menu-${record.id}`}>
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEdit?.(record.id); }} data-testid="button-edit">
                          Edit
                        </DropdownMenuItem>
                        {record.type === 'address' && onSyncDeeper && (
                          <DropdownMenuItem 
                            onClick={(e) => { e.stopPropagation(); onSyncDeeper(record.id); }} 
                            data-testid={`button-sync-deeper-${record.id}`}
                          >
                            <RefreshCw className="h-4 w-4 mr-2" />
                            Sync Deeper
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onDelete?.(record.id); }} className="text-destructive" data-testid="button-delete">
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
