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
import { MoreVertical, ArrowUpDown } from "lucide-react";
import { BitcoinAddressDisplay } from "./BitcoinAddressDisplay";
import { RecordTypeBadge } from "./RecordTypeBadge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface Record {
  id: string;
  type: "address" | "transaction";
  inputString: string;
  label: string;
  amount?: number;
  date?: string;
  tags: string[];
}

interface RecordTableProps {
  records: Record[];
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
  onRowClick?: (id: string) => void;
}

export function RecordTable({ records, onEdit, onDelete, onRowClick }: RecordTableProps) {
  return (
    <div className="border rounded-lg">
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
            <TableHead className="text-right">Amount</TableHead>
            <TableHead>Date</TableHead>
            <TableHead>Tags</TableHead>
            <TableHead className="w-[50px]"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {records.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
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
                <TableCell className="text-right font-mono" data-testid={`text-amount-${record.id}`}>
                  {record.amount !== undefined ? `${record.amount} BTC` : "-"}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground" data-testid={`text-date-${record.id}`}>
                  {record.date || "-"}
                </TableCell>
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
