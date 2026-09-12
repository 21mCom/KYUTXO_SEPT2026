import { FileText, AlertCircle, CheckCircle, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { truncateAddress } from "@/lib/bitcoin";
import { type AddressRow } from "./address-helpers";

interface ProvenanceStatus {
  address: string;
  recordId?: number;
  hasRecord: boolean;
  missing: string[];
}

interface ProvenanceCardProps {
  includeProvenance: boolean;
  setIncludeProvenance: (v: boolean) => void;
  provenanceFiatCurrency: string;
  setProvenanceFiatCurrency: (v: string) => void;
  provenanceStatus: ProvenanceStatus[];
  provenanceIncompleteCount: number;
  doneRows: AddressRow[];
  fiatValid: boolean;
  fiatTotal: number | null;
  openRecordEdit: (id: number, scrollToSection?: "acquisition") => void;
}

export function ProvenanceCard({
  includeProvenance,
  setIncludeProvenance,
  provenanceFiatCurrency,
  setProvenanceFiatCurrency,
  provenanceStatus,
  provenanceIncompleteCount,
  doneRows,
  fiatValid,
  fiatTotal,
  openRecordEdit,
}: ProvenanceCardProps) {
  return (<>
        {/* Step 8: Acquisition & Provenance */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Step 8 — Acquisition &amp; Provenance
              <Badge variant="secondary" className="ml-1 text-xs font-normal">Optional</Badge>
            </CardTitle>
            <CardDescription>
              Add an appendix documenting how the declared addresses acquired their Bitcoin:
              acquisition dates, methods, cost basis, and fiat values at time of acquisition.
              A list of linked supporting documents is included so a reviewer can cross-reference exhibits.
              Data is read from your vault records — nothing is changed.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="space-y-0.5">
                <Label htmlFor="include-provenance" className="text-sm font-medium">
                  Include Acquisition &amp; Provenance appendix in the PDF
                </Label>
                <p className="text-sm text-muted-foreground">
                  Off by default. When on, a per-address provenance table and supporting-documents
                  list are appended as a separate section.
                </p>
              </div>
              <Switch
                id="include-provenance"
                checked={includeProvenance}
                onCheckedChange={setIncludeProvenance}
                data-testid="switch-include-provenance"
              />
            </div>

            {includeProvenance && (
              <>
                <Separator />

                <div className="space-y-2 max-w-xs">
                  <Label htmlFor="provenance-currency" className="text-sm">
                    Fiat currency for cost basis and historical pricing
                  </Label>
                  <Select
                    value={provenanceFiatCurrency}
                    onValueChange={setProvenanceFiatCurrency}
                  >
                    <SelectTrigger id="provenance-currency" data-testid="select-provenance-currency">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="USD">USD — US Dollar</SelectItem>
                      <SelectItem value="EUR">EUR — Euro</SelectItem>
                      <SelectItem value="GBP">GBP — British Pound</SelectItem>
                      <SelectItem value="CAD">CAD — Canadian Dollar</SelectItem>
                      <SelectItem value="AUD">AUD — Australian Dollar</SelectItem>
                      <SelectItem value="CHF">CHF — Swiss Franc</SelectItem>
                      <SelectItem value="JPY">JPY — Japanese Yen</SelectItem>
                      <SelectItem value="SGD">SGD — Singapore Dollar</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Used for historical price lookups from your vault's stored price data.
                    Addresses with a manually recorded cost basis will show that value in USD
                    regardless of this setting.
                  </p>
                </div>

                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription className="text-sm space-y-1">
                    <p>
                      Acquisition data is read from your vault records. Addresses with no vault
                      record, or records with no acquisition metadata, are shown as "Not recorded."
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Historical fiat values are estimates from your vault's stored price data.
                      If no price data exists for an acquisition date, the cost basis will be
                      shown as "Not recorded." Figures are informational only.
                    </p>
                  </AlertDescription>
                </Alert>

                {doneRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    Check balances for at least one address (Step 2) to include this section.
                  </p>
                ) : (
                  <div className="rounded-md border bg-muted/30 px-4 py-3 text-sm space-y-1">
                    <div className="font-medium">What will be included</div>
                    <ul className="text-muted-foreground space-y-0.5 list-disc list-inside text-xs">
                      <li>
                        Per-address table: date acquired, acquisition method, BTC amount, and cost
                        basis in {provenanceFiatCurrency} (from price history or user-supplied basis)
                      </li>
                      <li>
                        Provenance summary: total BTC, total cost basis
                        {fiatValid && fiatTotal !== null ? ", current value, and unrealized gain/loss" : ""}
                      </li>
                      <li>Supporting documents: file attachments linked to the declared records</li>
                    </ul>
                  </div>
                )}

                {doneRows.length > 0 && (
                  <div className="space-y-2" data-testid="provenance-summary">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <Label className="text-sm font-medium">Provenance details per address</Label>
                      {provenanceIncompleteCount === 0 ? (
                        <Badge variant="secondary" className="text-xs font-normal" data-testid="badge-provenance-complete">
                          <CheckCircle className="h-3 w-3 mr-1" />
                          All recorded
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs font-normal" data-testid="badge-provenance-incomplete">
                          <AlertCircle className="h-3 w-3 mr-1" />
                          {provenanceIncompleteCount} need{provenanceIncompleteCount === 1 ? "s" : ""} attention
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Fields below are read into the appendix. Record them on each address to make
                      the appendix more complete.
                    </p>
                    <div className="rounded-md border divide-y">
                      {provenanceStatus.map((s) => (
                        <div
                          key={s.address}
                          className="flex items-center justify-between gap-3 px-3 py-2 flex-wrap"
                          data-testid={`provenance-row-${s.address}`}
                        >
                          <div className="min-w-0 space-y-1">
                            <div className="font-mono text-xs truncate" title={s.address}>
                              {truncateAddress(s.address)}
                            </div>
                            {!s.hasRecord ? (
                              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <AlertCircle className="h-3 w-3 shrink-0" />
                                No vault record — provenance can't be recorded
                              </div>
                            ) : s.missing.length === 0 ? (
                              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <CheckCircle className="h-3 w-3 shrink-0" />
                                All provenance fields recorded
                              </div>
                            ) : (
                              <div className="flex items-center gap-1 flex-wrap">
                                <span className="text-xs text-muted-foreground">Missing:</span>
                                {s.missing.map((m) => (
                                  <Badge
                                    key={m}
                                    variant="outline"
                                    className="text-xs font-normal"
                                  >
                                    {m}
                                  </Badge>
                                ))}
                              </div>
                            )}
                          </div>
                          {s.hasRecord && s.missing.length > 0 && s.recordId !== undefined && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => openRecordEdit(s.recordId!, "acquisition")}
                              data-testid={`button-fill-provenance-${s.address}`}
                            >
                              Fill in missing fields
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
  </>);
}
