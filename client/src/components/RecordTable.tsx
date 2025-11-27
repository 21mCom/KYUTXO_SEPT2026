import { useState, useEffect } from "react";
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
import { MoreVertical, ArrowUpDown, Settings2, Paperclip, Key } from "lucide-react";
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
}

interface RecordTableProps {
  records: Record[];
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
  onRowClick?: (id: string) => void;
}

export function RecordTable({ records, onEdit, onDelete, onRowClick }: RecordTableProps) {
  const { tableColumns, customFieldColumns } = useSettings();
  const { enabledCustomFields } = useCustomFields();
  const [attachmentCounts, setAttachmentCounts] = useState<Map<string, number>>(new Map());

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
            <TableHead className="w-[100px]">
              <Button variant="ghost" size="sm" className="h-8 gap-1" data-testid="button-sort-type">
                Type
                <ArrowUpDown className="h-3 w-3" />
              </Button>
            </TableHead>
            <TableHead>Label</TableHead>
            <TableHead>Address / TXID</TableHead>
            {tableColumns.tags && <TableHead>Tags</TableHead>}
            {tableColumns.categories && <TableHead>Categories</TableHead>}
            {tableColumns.walletSoftware && <TableHead>Wallet</TableHead>}
            {tableColumns.seedName && <TableHead>Seed</TableHead>}
            {tableColumns.privateKeyStatus && <TableHead>Private Key</TableHead>}
            {tableColumns.hasAttachments && <TableHead className="w-[50px]">Files</TableHead>}
            {tableColumns.source && <TableHead>Source</TableHead>}
            {enabledCustomFields.filter(f => customFieldColumns[f.slug]).map((field) => (
              <TableHead key={field.slug}>{field.name}</TableHead>
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
            records.map((record) => (
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
                    {record.source || "-"}
                  </TableCell>
                )}
                {enabledCustomFields.filter(f => customFieldColumns[f.slug]).map((field) => (
                  <TableCell key={field.slug} className="text-sm text-muted-foreground">
                    {record.customFields?.[field.slug] || "-"}
                  </TableCell>
                ))}
                <TableCell>
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
                      <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onDelete?.(record.id); }} className="text-destructive" data-testid="button-delete">
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
