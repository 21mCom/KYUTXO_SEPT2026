import { ChevronDown, ChevronUp, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import type { DerivedAddress, DerivedMultisigAddress, MultisigDualChainResult } from "@/lib/xpub";

export interface AddressPreviewTableProps {
  isMultisigMode: boolean;
  multisigResult: MultisigDualChainResult | null;
  activeReceiveAddresses: (DerivedAddress | DerivedMultisigAddress)[] | undefined;
  activeChangeAddresses: (DerivedAddress | DerivedMultisigAddress)[] | undefined;
  selectedReceiveAddresses: Set<number>;
  selectedChangeAddresses: Set<number>;
  totalSelectedAddresses: number;
  showChangeAddresses: boolean;
  onSetShowChangeAddresses: (show: boolean) => void;
  onToggleReceiveSelection: (index: number) => void;
  onToggleChangeSelection: (index: number) => void;
  onToggleAllReceiveAddresses: () => void;
  onToggleAllChangeAddresses: () => void;
}

export default function AddressPreviewTable({
  isMultisigMode,
  multisigResult,
  activeReceiveAddresses,
  activeChangeAddresses,
  selectedReceiveAddresses,
  selectedChangeAddresses,
  totalSelectedAddresses,
  showChangeAddresses,
  onSetShowChangeAddresses,
  onToggleReceiveSelection,
  onToggleChangeSelection,
  onToggleAllReceiveAddresses,
  onToggleAllChangeAddresses,
}: AddressPreviewTableProps) {
  return (
    <>
      {isMultisigMode && multisigResult && (
        <div className="p-3 bg-primary/10 rounded-md mb-2 flex items-center gap-2 flex-wrap">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <span className="font-medium">Multisig Addresses</span>
          <Badge variant="secondary">{multisigResult.m}-of-{multisigResult.n}</Badge>
          <Badge variant="outline">{multisigResult.scriptType.toUpperCase()}</Badge>
        </div>
      )}
      
      <div className="p-3 bg-muted rounded-md mb-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm font-medium">
            Total: {totalSelectedAddresses} addresses selected
          </p>
          <div className="flex gap-2">
            {((activeChangeAddresses)?.length ?? 0) > 0 ? (
              <>
                <Badge variant="secondary">{selectedReceiveAddresses.size} receive</Badge>
                <Badge variant="outline">{selectedChangeAddresses.size} change</Badge>
              </>
            ) : (
              <Badge variant="secondary">{selectedReceiveAddresses.size} addresses</Badge>
            )}
          </div>
        </div>
        {!isMultisigMode && activeChangeAddresses?.length === 0 && (
          <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">
            Chain-level key: only single chain derivation available
          </p>
        )}
      </div>

      <div className="space-y-4">
        <div className="border rounded-lg overflow-hidden">
          <div className="bg-primary/10 p-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Checkbox
                checked={activeReceiveAddresses && selectedReceiveAddresses.size === activeReceiveAddresses.length}
                onCheckedChange={onToggleAllReceiveAddresses}
                data-testid="checkbox-select-all-receive"
              />
              <Label className="cursor-pointer font-medium" onClick={onToggleAllReceiveAddresses}>
                {(activeChangeAddresses?.length ?? 0) > 0 ? 'Receive Addresses (External)' : 'Derived Addresses'}
              </Label>
              <Badge variant="secondary" className="text-xs">
                {selectedReceiveAddresses.size}/{activeReceiveAddresses?.length ?? 0}
              </Badge>
            </div>
          </div>
          <div className="space-y-2 max-h-[200px] overflow-y-auto p-2">
            {activeReceiveAddresses?.map((addr, index) => (
              <div
                key={`receive-${index}`}
                className={`flex items-center gap-3 p-3 border rounded hover-elevate ${
                  selectedReceiveAddresses.has(index) ? "bg-primary/5 border-primary/30" : ""
                }`}
                data-testid={`address-preview-receive-${index}`}
              >
                <Checkbox
                  checked={selectedReceiveAddresses.has(index)}
                  onCheckedChange={() => onToggleReceiveSelection(index)}
                  data-testid={`checkbox-receive-${index}`}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant="outline" className="text-xs">
                      #{addr.index}
                    </Badge>
                    {'path' in addr && <code className="text-xs text-muted-foreground">{addr.path}</code>}
                  </div>
                  <code className="text-sm font-mono break-all">{addr.address}</code>
                </div>
              </div>
            ))}
          </div>
        </div>

        {(activeChangeAddresses?.length ?? 0) > 0 && (
          <div className="border rounded-lg overflow-hidden">
            <div 
              className="bg-muted p-3 flex items-center justify-between cursor-pointer hover-elevate"
              onClick={() => onSetShowChangeAddresses(!showChangeAddresses)}
              data-testid="toggle-change-addresses"
            >
              <div className="flex items-center gap-2">
                <Checkbox
                  checked={activeChangeAddresses && selectedChangeAddresses.size === activeChangeAddresses.length}
                  onCheckedChange={() => onToggleAllChangeAddresses()}
                  onClick={(e) => e.stopPropagation()}
                  data-testid="checkbox-select-all-change"
                />
                <Label className="cursor-pointer font-medium">
                  Change Addresses (Internal)
                </Label>
                <Badge variant="outline" className="text-xs">
                  {selectedChangeAddresses.size}/{activeChangeAddresses?.length ?? 0}
                </Badge>
              </div>
              <Button variant="ghost" size="sm">
                {showChangeAddresses ? (
                  <>Hide <ChevronUp className="h-4 w-4 ml-1" /></>
                ) : (
                  <>Show <ChevronDown className="h-4 w-4 ml-1" /></>
                )}
              </Button>
            </div>
            {showChangeAddresses && (
              <div className="space-y-2 max-h-[200px] overflow-y-auto p-2">
                {activeChangeAddresses?.map((addr, index) => (
                  <div
                    key={`change-${index}`}
                    className={`flex items-center gap-3 p-3 border rounded hover-elevate ${
                      selectedChangeAddresses.has(index) ? "bg-primary/5 border-primary/30" : ""
                    }`}
                    data-testid={`address-preview-change-${index}`}
                  >
                    <Checkbox
                      checked={selectedChangeAddresses.has(index)}
                      onCheckedChange={() => onToggleChangeSelection(index)}
                      data-testid={`checkbox-change-${index}`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant="outline" className="text-xs">
                          #{addr.index}
                        </Badge>
                        {'path' in addr && <code className="text-xs text-muted-foreground">{addr.path}</code>}
                      </div>
                      <code className="text-sm font-mono break-all">{addr.address}</code>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
