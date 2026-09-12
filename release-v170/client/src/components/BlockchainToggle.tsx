import { Users, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface BlockchainToggleProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  hiddenCount: number;
  className?: string;
}

export function BlockchainToggle({
  checked,
  onCheckedChange,
  hiddenCount,
  className,
}: BlockchainToggleProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onCheckedChange(!checked)}
          className={cn(
            "relative",
            checked && "text-primary",
            className
          )}
          data-testid="button-blockchain-toggle"
        >
          {checked ? (
            <Eye className="h-4 w-4" />
          ) : (
            <EyeOff className="h-4 w-4" />
          )}
          {!checked && hiddenCount > 0 && (
            <Badge 
              variant="secondary" 
              className="absolute -top-1 -right-1 h-4 min-w-4 px-1 text-[10px] leading-none"
            >
              +{hiddenCount > 999 ? '999+' : hiddenCount}
            </Badge>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end" className="max-w-[280px]">
        <div className="space-y-1">
          <p className="font-medium">
            {checked ? "Showing all addresses" : "Showing your addresses only"}
          </p>
          <p className="text-xs text-muted-foreground">
            {checked 
              ? "Includes blockchain-discovered addresses. May impact performance with large datasets."
              : `${hiddenCount.toLocaleString()} blockchain-discovered address${hiddenCount !== 1 ? 'es' : ''} hidden.`
            }
          </p>
          <p className="text-xs text-muted-foreground">
            Click to {checked ? "hide" : "show"} blockchain-discovered data.
          </p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
