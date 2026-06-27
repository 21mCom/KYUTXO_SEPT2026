import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";

interface BitcoinAddressDisplayProps {
  address: string;
  truncate?: boolean;
  className?: string;
}

export function BitcoinAddressDisplay({ address, truncate = true, className = "" }: BitcoinAddressDisplayProps) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({ description: "Address copied" });
    } catch {
      toast({
        title: "Copy failed",
        description: "Could not copy the address to your clipboard.",
        variant: "destructive",
      });
    }
  };

  const displayAddress = truncate && address.length > 20
    ? `${address.slice(0, 10)}...${address.slice(-10)}`
    : address;

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <Tooltip>
        <TooltipTrigger asChild>
          <code className="font-mono text-sm bg-muted px-2 py-1 rounded" data-testid="text-address">
            {displayAddress}
          </code>
        </TooltipTrigger>
        <TooltipContent>
          <p className="font-mono text-xs">{address}</p>
        </TooltipContent>
      </Tooltip>
      <Button
        size="icon"
        variant="ghost"
        onClick={handleCopy}
        data-testid="button-copy-address"
      >
        {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
      </Button>
    </div>
  );
}
