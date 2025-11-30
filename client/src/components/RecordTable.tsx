import { useState, useEffect, useMemo } from "react";
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
import { BitcoinAddressDisplay } from "./BitcoinAddressDisplay";
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

type SortDirection = "asc" | "desc" | null;
type SortColumn = "type" | "label" | "inputString" | "tags" | "categories" | "walletSoftware" | "seedName" | "privateKeyStatus" | "attachments" | "source" | string;

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
  source?: string;
  customFields?: { [key: string]: string };
  syncDepth?: number;
  maxSyncedDepth?: number;
}

interface RecordTableProps {
  records: Record[];
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
  onRowClick?: (id: string) => void;
  onSyncDeeper?: (id: string) => void;
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

export function RecordTable({ records, onEdit, onDelete, onRowClick, onSyncDeeper }: RecordTableProps) {
  const { tableColumns, customFieldColumns } = useSettings();
  const { enabledCustomFields } = useCustomFields();
  const [attachmentCounts, setAttachmentCounts] = useState<Map<string, number>>(new Map());
  const [sortColumn, setSortColumn] = useState<SortColumn | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>(null);

  useEffect(() => {
    const loadAttachmentCounts = async () => {
      const counts = new Map<string, number>();
      for (const record of records) {
        const count = await db.attachments.where('recordId').equals(Number(record.id)).count();
        counts.set(record.id, count);
      }
      setAttachmentCounts(counts);
    };
    
    if (records.length > 0) {
      loadAttachmentCounts();
    }
  }, [records]);

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      if (sortDirection === "asc") {
        setSortDirection("desc");
      } else if (sortDirection === "desc") {
        setSortColumn(null);
        setSortDirection(null);
      } else {
        setSortDirection("asc");
      }
    } else {
      setSortColumn(column);
      setSortDirection("asc");
    }
  };

  const sortedRecords = useMemo(() => {
    if (!sortColumn || !sortDirection) {
      return records;
    }

    return [...records].sort((a, b) => {
      let aVal: string | number = "";
      let bVal: string | number = "";

      switch (sortColumn) {
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
        case "source":
          aVal = (a.source || "").toLowerCase();
          bVal = (b.source || "").toLowerCase();
          break;
        default:
          if (sortColumn.startsWith("custom_")) {
            const fieldSlug = sortColumn.replace("custom_", "");
            aVal = (a.customFields?.[fieldSlug] || "").toLowerCase();
            bVal = (b.customFields?.[fieldSlug] || "").toLowerCase();
          }
      }

      if (aVal < bVal) return sortDirection === "asc" ? -1 : 1;
      if (aVal > bVal) return sortDirection === "asc" ? 1 : -1;
      return 0;
    });
  }, [records, sortColumn, sortDirection, attachmentCounts]);

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

  return (
    <div className="border rounded-lg">
      <div className="flex items-center justify-end p-2 border-b">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="gap-2" data-testid="button-column-settings">
              <Settings2 className="h-4 w-4" />
              Columns
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56">
            <div className="space-y-2">
              <p className="text-sm font-medium mb-3">Visible Columns</p>
              <div className="space-y-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={tableColumns.tags}
                    onCheckedChange={() => toggleTableColumn('tags')}
                    data-testid="checkbox-col-tags"
                  />
                  <span className="text-sm">Tags</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={tableColumns.categories}
                    onCheckedChange={() => toggleTableColumn('categories')}
                    data-testid="checkbox-col-categories"
                  />
                  <span className="text-sm">Categories</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={tableColumns.walletSoftware}
                    onCheckedChange={() => toggleTableColumn('walletSoftware')}
                    data-testid="checkbox-col-wallet"
                  />
                  <span className="text-sm">Wallet Software</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={tableColumns.seedName}
                    onCheckedChange={() => toggleTableColumn('seedName')}
                    data-testid="checkbox-col-seed"
                  />
                  <span className="text-sm">Seed Name</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={tableColumns.privateKeyStatus}
                    onCheckedChange={() => toggleTableColumn('privateKeyStatus')}
                    data-testid="checkbox-col-privatekey"
                  />
                  <span className="text-sm">Private Key</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={tableColumns.hasAttachments}
                    onCheckedChange={() => toggleTableColumn('hasAttachments')}
                    data-testid="checkbox-col-attachments"
                  />
                  <span className="text-sm">Attachments</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={tableColumns.source}
                    onCheckedChange={() => toggleTableColumn('source')}
                    data-testid="checkbox-col-source"
                  />
                  <span className="text-sm">Source</span>
                </label>
              </div>
              {enabledCustomFields.length > 0 && (
                <>
                  <Separator className="my-2" />
                  <p className="text-sm font-medium mb-2 text-muted-foreground">Custom Fields</p>
                  <div className="space-y-2">
                    {enabledCustomFields.map((field) => (
                      <label key={field.slug} className="flex items-center gap-2 cursor-pointer">
                        <Checkbox
                          checked={customFieldColumns[field.slug] || false}
                          onCheckedChange={() => toggleCustomFieldColumn(field.slug)}
                          data-testid={`checkbox-col-custom-${field.slug}`}
                        />
                        <span className="text-sm">{field.name}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>
          </PopoverContent>
        </Popover>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
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
                  (tableColumns.tags ? 1 : 0) + 
                  (tableColumns.categories ? 1 : 0) + 
                  (tableColumns.walletSoftware ? 1 : 0) + 
                  (tableColumns.seedName ? 1 : 0) + 
                  (tableColumns.privateKeyStatus ? 1 : 0) + 
                  (tableColumns.hasAttachments ? 1 : 0) +
                  (tableColumns.source ? 1 : 0) +
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
                className="cursor-pointer hover-elevate"
                onClick={() => onRowClick?.(record.id)}
                data-testid={`row-record-${record.id}`}
              >
                <TableCell>
                  <RecordTypeBadge type={record.type} />
                </TableCell>
                <TableCell className="font-medium" data-testid={`text-label-${record.id}`}>
                  {record.label}
                </TableCell>
                <TableCell>
                  <BitcoinAddressDisplay address={record.inputString} />
                </TableCell>
                {tableColumns.tags && (
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {record.tags.slice(0, 2).map((tag) => (
                        <Badge key={tag} variant="outline" className="text-xs">
                          {tag}
                        </Badge>
                      ))}
                      {record.tags.length > 2 && (
                        <Badge variant="outline" className="text-xs">
                          +{record.tags.length - 2}
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
                    {record.source && record.source !== '[encrypted]' ? record.source : "-"}
                  </TableCell>
                )}
                {enabledCustomFields.filter(f => customFieldColumns[f.slug]).map((field) => {
                  const value = record.customFields?.[field.slug];
                  const displayValue = value && value !== '[encrypted]' ? value : "-";
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
