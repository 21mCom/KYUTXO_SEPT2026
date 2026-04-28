import { useState, useEffect, useMemo, useCallback } from "react";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { PAGE_DEBOUNCE } from "@/config/debounce";
import { useLocation } from "wouter";
import { Layers, Users, ChevronDown, ChevronRight, Search, ExternalLink, Wallet, Pencil, Check, X, StickyNote, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import { updateRecord } from "@/lib/dataFacade";
import { db } from "@/lib/database";
import type { VaultMetadata, Record as DbRecord } from "@/lib/database";

interface CosignerDetail {
  index: number;
  name: string;
  notes?: string;
  xpubPreview?: string;
}

interface ParsedVaultNotes {
  cosigners?: CosignerDetail[];
  scriptType?: string;
  userNotes?: string;
}

interface VaultSummary {
  vaultKey: string;
  vaultName: string;
  m: number;
  n: number;
  scriptType?: string;
  cosigners: CosignerDetail[];
  userNotes?: string;
  addressCount: number;
  addressIds: number[];
}

function parseVaultNotes(vaultNotes?: string | null): ParsedVaultNotes | null {
  if (!vaultNotes) return null;
  try {
    const parsed = JSON.parse(vaultNotes);
    if (parsed && typeof parsed === 'object') {
      const result: ParsedVaultNotes = {};
      if (Array.isArray(parsed.cosigners)) {
        result.cosigners = parsed.cosigners.map((c: CosignerDetail) => ({
          index: c.index ?? 0,
          name: c.name || `Cosigner ${c.index ?? 0}`,
          notes: c.notes,
          xpubPreview: c.xpubPreview,
        }));
      }
      if (parsed.scriptType) result.scriptType = String(parsed.scriptType);
      if (parsed.userNotes) result.userNotes = String(parsed.userNotes);
      if (result.cosigners || result.scriptType || result.userNotes) {
        return result;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function generateVaultKey(vault: VaultMetadata): string {
  const parsed = parseVaultNotes(vault.vaultNotes);
  const scriptType = parsed?.scriptType || '';
  const cosignerXpubs = parsed?.cosigners?.map(c => c.xpubPreview || '').sort().join(',') || '';
  return `${vault.vaultName || 'Unnamed'}-${vault.m}-${vault.n}-${scriptType}-${cosignerXpubs}`;
}

export default function VaultManagement() {
  const [, navigate] = useLocation();
  const [vaults, setVaults] = useState<VaultSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, isSearchPending] = useDebouncedValue(searchQuery, PAGE_DEBOUNCE.VaultManagement);
  const [expandedVaults, setExpandedVaults] = useState<Set<string>>(new Set());
  const [editingNotesVault, setEditingNotesVault] = useState<string | null>(null);
  const [editNotesText, setEditNotesText] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    async function loadVaults() {
      setLoading(true);
      try {
        const VAULT_TIERS = ['xpub-derived', 'verified'];
        const rawRecords = await db.records
          .where('[type+addressImportance]')
          .anyOf(VAULT_TIERS.map(tier => ['address', tier]))
          .toArray();

        const vaultMap = new Map<string, VaultSummary>();

        for (const record of rawRecords) {
          if (record.vault?.isVaultXpub && record.vault.m && record.vault.n) {
            const key = generateVaultKey(record.vault);
            const parsed = parseVaultNotes(record.vault.vaultNotes);
            
            if (!vaultMap.has(key)) {
              vaultMap.set(key, {
                vaultKey: key,
                vaultName: record.vault.vaultName || 'Unnamed Vault',
                m: record.vault.m,
                n: record.vault.n,
                scriptType: parsed?.scriptType,
                cosigners: parsed?.cosigners || [],
                userNotes: parsed?.userNotes,
                addressCount: 0,
                addressIds: [],
              });
            }
            
            const vault = vaultMap.get(key)!;
            vault.addressCount++;
            if (record.id) {
              vault.addressIds.push(record.id);
            }
          }
        }

        setVaults(Array.from(vaultMap.values()).sort((a, b) => 
          a.vaultName.localeCompare(b.vaultName)
        ));
      } catch (error) {
        console.error("Failed to load vaults:", error);
      } finally {
        setLoading(false);
      }
    }

    loadVaults();
  }, []);

  const filteredVaults = useMemo(() => {
    if (!debouncedSearchQuery.trim()) return vaults;
    const query = debouncedSearchQuery.toLowerCase();
    return vaults.filter(vault => 
      vault.vaultName.toLowerCase().includes(query) ||
      vault.cosigners.some(c => (c.name || '').toLowerCase().includes(query)) ||
      (vault.scriptType || '').toLowerCase().includes(query) ||
      (vault.userNotes || '').toLowerCase().includes(query)
    );
  }, [vaults, debouncedSearchQuery]);

  const toggleVaultExpanded = (vaultName: string) => {
    setExpandedVaults(prev => {
      const newSet = new Set(prev);
      if (newSet.has(vaultName)) {
        newSet.delete(vaultName);
      } else {
        newSet.add(vaultName);
      }
      return newSet;
    });
  };

  const handleViewAddresses = (vault: VaultSummary) => {
    navigate(`/?vaultName=${encodeURIComponent(vault.vaultName)}`);
  };

  const startEditingNotes = (vault: VaultSummary) => {
    setEditingNotesVault(vault.vaultKey);
    setEditNotesText(vault.userNotes || "");
  };

  const cancelEditingNotes = () => {
    setEditingNotesVault(null);
    setEditNotesText("");
  };

  const saveVaultNotes = useCallback(async (vault: VaultSummary) => {
    setSavingNotes(true);
    try {
      const rawRecords = await db.records
        .where('id')
        .anyOf(vault.addressIds)
        .toArray();

      const vaultRecords = rawRecords.filter(r => {
        if (!r.vault?.isVaultXpub || !r.vault.m || !r.vault.n) return false;
        return generateVaultKey(r.vault) === vault.vaultKey;
      });

      const trimmedNotes = editNotesText.trim();

      for (const record of vaultRecords) {
        if (!record.id) continue;
        const existingParsed = parseVaultNotes(record.vault?.vaultNotes);
        const newVaultNotesObj: ParsedVaultNotes = {
          cosigners: existingParsed?.cosigners,
          scriptType: existingParsed?.scriptType,
          userNotes: trimmedNotes || undefined,
        };
        const newVaultNotes = JSON.stringify(newVaultNotesObj);
        await updateRecord(record.id, {
          vault: {
            ...record.vault!,
            vaultNotes: newVaultNotes,
          },
        });
      }

      setVaults(prev => prev.map(v => {
        if (v.vaultKey === vault.vaultKey) {
          return { ...v, userNotes: trimmedNotes || undefined };
        }
        return v;
      }));

      setEditingNotesVault(null);
      setEditNotesText("");
      toast({ title: "Notes saved", description: `Updated notes across ${vaultRecords.length} address records.` });
    } catch (error) {
      console.error("Failed to save vault notes:", error);
      toast({ title: "Error", description: "Failed to save vault notes.", variant: "destructive" });
    } finally {
      setSavingNotes(false);
    }
  }, [editNotesText, toast]);

  if (loading) {
    return (
      <div className="p-6">
        <div className="flex items-center gap-2 mb-6">
          <Layers className="h-6 w-6" />
          <h1 className="text-2xl font-semibold">Vault Management</h1>
        </div>
        <div className="flex items-center justify-center h-64">
          <p className="text-muted-foreground">Loading vaults...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6" data-testid="page-vault-management">
      <div className="flex items-center gap-2 mb-6">
        <Layers className="h-6 w-6" />
        <h1 className="text-2xl font-semibold" data-testid="heading-vault-management">Vault Management</h1>
      </div>

      <div className="mb-6">
        <div className="relative">
          {isSearchPending ? (
            <Loader2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground animate-spin" data-testid="icon-search-pending" />
          ) : (
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          )}
          <Input
            placeholder="Search vaults by name, cosigner, or script type..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
            data-testid="input-search-vaults"
          />
        </div>
      </div>

      <div className={`transition-opacity duration-200 ${isSearchPending ? 'opacity-60' : ''}`}>
      {filteredVaults.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Layers className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <h3 className="text-lg font-medium mb-2" data-testid="text-no-vaults">
              {vaults.length === 0 ? "No Multisig Vaults Found" : "No Matching Vaults"}
            </h3>
            <p className="text-sm text-muted-foreground mb-4">
              {vaults.length === 0 
                ? "Import addresses from a multisig wallet using the Address Importer to see your vaults here."
                : "Try adjusting your search query."}
            </p>
            {vaults.length === 0 && (
              <Button onClick={() => navigate("/import")} data-testid="button-go-to-import">
                Go to Address Importer
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <ScrollArea className="h-[calc(100vh-200px)]">
          <div className="space-y-4 pr-4">
            {filteredVaults.map((vault, idx) => (
              <Card key={`${vault.vaultName}-${idx}`} data-testid={`card-vault-${idx}`}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <CardTitle className="text-lg flex items-center gap-2 flex-wrap" data-testid={`text-vault-name-${idx}`}>
                        <Wallet className="h-5 w-5 shrink-0" />
                        {vault.vaultName}
                      </CardTitle>
                      <CardDescription className="mt-1 flex flex-wrap items-center gap-2">
                        <Badge variant="secondary" data-testid={`badge-quorum-${idx}`}>
                          {vault.m} of {vault.n}
                        </Badge>
                        {vault.scriptType && (
                          <Badge variant="outline" data-testid={`badge-script-type-${idx}`}>
                            {vault.scriptType}
                          </Badge>
                        )}
                        <span className="text-muted-foreground" data-testid={`text-address-count-${idx}`}>
                          {vault.addressCount} address{vault.addressCount !== 1 ? 'es' : ''}
                        </span>
                      </CardDescription>
                    </div>
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={() => handleViewAddresses(vault)}
                      data-testid={`button-view-addresses-${idx}`}
                    >
                      <ExternalLink className="h-4 w-4 mr-1" />
                      View Addresses
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="pt-0 space-y-3">
                  {vault.cosigners.length > 0 && (
                    <Collapsible 
                      open={expandedVaults.has(vault.vaultName)} 
                      onOpenChange={() => toggleVaultExpanded(vault.vaultName)}
                    >
                      <CollapsibleTrigger asChild>
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          className="w-full justify-between text-sm gap-1"
                          data-testid={`button-toggle-cosigners-${idx}`}
                        >
                          <span className="flex items-center gap-2">
                            <Users className="h-4 w-4" />
                            Cosigners ({vault.cosigners.length})
                          </span>
                          {expandedVaults.has(vault.vaultName) 
                            ? <ChevronDown className="h-4 w-4" /> 
                            : <ChevronRight className="h-4 w-4" />}
                        </Button>
                      </CollapsibleTrigger>
                      <CollapsibleContent className="pt-3 space-y-2">
                        {vault.cosigners.map((cosigner, cIdx) => (
                          <div 
                            key={cIdx} 
                            className="pl-3 border-l-2 border-muted-foreground/30 space-y-1"
                            data-testid={`cosigner-${idx}-${cIdx}`}
                          >
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-medium" data-testid={`text-cosigner-name-${idx}-${cIdx}`}>
                                {cosigner.name}
                              </span>
                              {cosigner.xpubPreview && (
                                <code className="text-xs text-muted-foreground bg-muted px-1 rounded" data-testid={`text-cosigner-xpub-${idx}-${cIdx}`}>
                                  {cosigner.xpubPreview}
                                </code>
                              )}
                            </div>
                            {cosigner.notes && (
                              <p className="text-xs text-muted-foreground" data-testid={`text-cosigner-notes-${idx}-${cIdx}`}>
                                {cosigner.notes}
                              </p>
                            )}
                          </div>
                        ))}
                      </CollapsibleContent>
                    </Collapsible>
                  )}
                  {(() => {
                    const isEditing = editingNotesVault === vault.vaultKey;
                    return (
                      <div className="pt-2 border-t">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <p className="text-xs text-muted-foreground flex items-center gap-1">
                            <StickyNote className="h-3 w-3" />
                            Notes
                          </p>
                          {!isEditing && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => startEditingNotes(vault)}
                              data-testid={`button-edit-notes-${idx}`}
                            >
                              <Pencil className="h-3 w-3" />
                            </Button>
                          )}
                        </div>
                        {isEditing ? (
                          <div className="space-y-2">
                            <Textarea
                              value={editNotesText}
                              onChange={(e) => setEditNotesText(e.target.value)}
                              placeholder="Add notes about this vault..."
                              className="text-sm min-h-[80px]"
                              autoFocus
                              data-testid={`textarea-vault-notes-${idx}`}
                            />
                            <div className="flex items-center justify-end gap-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={cancelEditingNotes}
                                disabled={savingNotes}
                                data-testid={`button-cancel-notes-${idx}`}
                              >
                                <X className="h-3 w-3 mr-1" />
                                Cancel
                              </Button>
                              <Button
                                size="sm"
                                onClick={() => saveVaultNotes(vault)}
                                disabled={savingNotes}
                                data-testid={`button-save-notes-${idx}`}
                              >
                                <Check className="h-3 w-3 mr-1" />
                                {savingNotes ? "Saving..." : "Save"}
                              </Button>
                            </div>
                          </div>
                        ) : vault.userNotes ? (
                          <p
                            className="text-sm whitespace-pre-wrap cursor-pointer hover-elevate rounded p-1 -mx-1"
                            onClick={() => startEditingNotes(vault)}
                            data-testid={`text-vault-notes-${idx}`}
                          >
                            {vault.userNotes}
                          </p>
                        ) : (
                          <p
                            className="text-sm text-muted-foreground italic cursor-pointer hover-elevate rounded p-1 -mx-1"
                            onClick={() => startEditingNotes(vault)}
                            data-testid={`text-vault-notes-empty-${idx}`}
                          >
                            Click to add notes...
                          </p>
                        )}
                      </div>
                    );
                  })()}
                </CardContent>
              </Card>
            ))}
          </div>
        </ScrollArea>
      )}
      </div>
    </div>
  );
}
