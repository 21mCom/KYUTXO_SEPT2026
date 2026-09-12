import { Plus, X, ChevronDown, AlertCircle, Info, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import {
  getMultisigScriptTypeDescription,
  type MultisigScriptType,
  type MultisigXpubEntry,
} from "@/lib/xpub";

export interface MultisigConfigPanelProps {
  multisigXpubs: MultisigXpubEntry[];
  multisigM: number;
  multisigScriptType: MultisigScriptType;
  multisigValidationError: string | null;
  multisigN: number;
  effectiveM: number;
  validMultisigXpubs: MultisigXpubEntry[];
  onAddXpub: () => void;
  onRemoveXpub: (index: number) => void;
  onUpdateXpub: (index: number, field: 'xpub' | 'derivationPath' | 'name' | 'notes', value: string) => void;
  onSetMultisigM: (value: number) => void;
  onSetMultisigScriptType: (value: MultisigScriptType) => void;
}

export default function MultisigConfigPanel({
  multisigXpubs,
  multisigM,
  multisigScriptType,
  multisigValidationError,
  multisigN,
  effectiveM,
  validMultisigXpubs,
  onAddXpub,
  onRemoveXpub,
  onUpdateXpub,
  onSetMultisigM,
  onSetMultisigScriptType,
}: MultisigConfigPanelProps) {
  return (
    <div className="space-y-4">
      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>
          For multisig wallets, you need <strong>all cosigner xpubs</strong> to derive the correct addresses.
          The addresses are created by combining sorted public keys from all signers.
        </AlertDescription>
      </Alert>

      <div className="space-y-2">
        <Label className="text-base font-medium">Script Type</Label>
        <Select
          value={multisigScriptType}
          onValueChange={(value) => onSetMultisigScriptType(value as MultisigScriptType)}
        >
          <SelectTrigger data-testid="select-multisig-script-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="p2wsh">Native SegWit (P2WSH) - bc1q... (lowest fees)</SelectItem>
            <SelectItem value="p2sh-p2wsh">Nested SegWit (P2SH-P2WSH) - 3... (compatible)</SelectItem>
            <SelectItem value="p2sh">Legacy (P2SH) - 3... (highest fees)</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {getMultisigScriptTypeDescription(multisigScriptType)}
        </p>
      </div>

      <div className="space-y-2">
        <Label className="text-base font-medium">Signature Threshold</Label>
        <div className="flex items-center gap-2 flex-wrap">
          <Select
            value={multisigM.toString()}
            onValueChange={(value) => onSetMultisigM(parseInt(value))}
          >
            <SelectTrigger className="w-24" data-testid="select-multisig-m">
              <SelectValue placeholder="M" />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: Math.max(multisigN, 2) }, (_, i) => i + 1).map((num) => (
                <SelectItem key={num} value={num.toString()}>{num}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-muted-foreground">of</span>
          <Badge variant="secondary" data-testid="badge-multisig-n">{multisigN}</Badge>
          <span className="text-sm text-muted-foreground">signatures required</span>
        </div>
        {effectiveM !== multisigM && multisigN >= 2 && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Threshold adjusted to {effectiveM} (maximum for {multisigN} signers)
          </p>
        )}
      </div>

      <div className="space-y-3">
        <Label className="text-base font-medium">Cosigner Extended Public Keys</Label>
        {multisigXpubs.map((entry, index) => (
          <div key={index} className="p-4 border rounded-lg space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <Label className="font-medium shrink-0">Cosigner {index + 1}</Label>
                <Input
                  value={entry.name || ''}
                  onChange={(e) => onUpdateXpub(index, 'name', e.target.value)}
                  placeholder="Name (e.g., Hardware Wallet)"
                  className="flex-1 text-sm"
                  data-testid={`input-cosigner-name-${index}`}
                />
              </div>
              {multisigXpubs.length > 2 && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onRemoveXpub(index)}
                  data-testid={`button-remove-xpub-${index}`}
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
            <Textarea
              value={entry.xpub}
              onChange={(e) => onUpdateXpub(index, 'xpub', e.target.value)}
              placeholder={`xpub6D... / zpub6D... (Cosigner ${index + 1})`}
              className="font-mono text-sm"
              rows={3}
              data-testid={`input-multisig-xpub-${index}`}
            />
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="text-xs gap-1" data-testid={`button-cosigner-advanced-${index}`}>
                  <ChevronDown className="h-3 w-3" />
                  Advanced Options
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-2 space-y-3">
                <div>
                  <Label className="text-xs text-muted-foreground">Custom Derivation Path</Label>
                  <Input
                    value={entry.derivationPath || ''}
                    onChange={(e) => onUpdateXpub(index, 'derivationPath', e.target.value)}
                    placeholder="Optional: e.g., 0 or 0/0 (default: auto-detect)"
                    className="font-mono text-sm mt-1"
                    data-testid={`input-multisig-path-${index}`}
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Leave empty for auto-detection based on key depth
                  </p>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Notes</Label>
                  <Textarea
                    value={entry.notes || ''}
                    onChange={(e) => onUpdateXpub(index, 'notes', e.target.value)}
                    placeholder="Optional notes about this cosigner..."
                    className="text-sm mt-1"
                    rows={2}
                    data-testid={`input-cosigner-notes-${index}`}
                  />
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        ))}

        {multisigXpubs.length < 15 && (
          <Button
            variant="outline"
            onClick={onAddXpub}
            className="w-full"
            data-testid="button-add-cosigner"
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Cosigner
          </Button>
        )}
      </div>

      {multisigValidationError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Validation Error</AlertTitle>
          <AlertDescription>{multisigValidationError}</AlertDescription>
        </Alert>
      )}

      {validMultisigXpubs.length >= 2 && !multisigValidationError && (
        <Alert>
          <ShieldCheck className="h-4 w-4" />
          <AlertTitle>Multisig Configuration</AlertTitle>
          <AlertDescription>
            <div className="flex flex-wrap gap-2 mt-2">
              <Badge variant="secondary">{effectiveM}-of-{multisigN}</Badge>
              <Badge variant="outline">{multisigScriptType.toUpperCase()}</Badge>
            </div>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
