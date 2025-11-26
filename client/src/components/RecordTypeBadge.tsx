import { Badge } from "@/components/ui/badge";
import { Wallet, ArrowLeftRight } from "lucide-react";

interface RecordTypeBadgeProps {
  type: "address" | "transaction";
  className?: string;
}

export function RecordTypeBadge({ type, className }: RecordTypeBadgeProps) {
  return (
    <Badge variant="secondary" className={className} data-testid={`badge-type-${type}`}>
      {type === "address" ? (
        <>
          <Wallet className="h-3 w-3 mr-1" />
          Address
        </>
      ) : (
        <>
          <ArrowLeftRight className="h-3 w-3 mr-1" />
          Transaction
        </>
      )}
    </Badge>
  );
}
