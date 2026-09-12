import { Badge } from "@/components/ui/badge";
import { Wallet, ArrowLeftRight, Coins } from "lucide-react";

interface RecordTypeBadgeProps {
  type: "address" | "transaction" | "other";
  className?: string;
}

export function RecordTypeBadge({ type, className }: RecordTypeBadgeProps) {
  const getContent = () => {
    switch (type) {
      case "address":
        return (
          <>
            <Wallet className="h-3 w-3 mr-1" />
            Address
          </>
        );
      case "transaction":
        return (
          <>
            <ArrowLeftRight className="h-3 w-3 mr-1" />
            Transaction
          </>
        );
      case "other":
        return (
          <>
            <Coins className="h-3 w-3 mr-1" />
            Other
          </>
        );
      default:
        return null;
    }
  };

  return (
    <Badge variant="secondary" className={className} data-testid={`badge-type-${type}`}>
      {getContent()}
    </Badge>
  );
}
