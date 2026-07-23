import { Shield, ShieldAlert, AlertCircle, Loader2, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AML_PREVIEW_STRINGS,
  buildEntityListDescription,
  buildPreviewDirectMatchLine,
  buildNearestEntityLine,
} from "@/lib/amlAppendixStrings";
import { type AmlScreeningResult } from "./aml-screening";
import { type AddressRow } from "./address-helpers";

interface AmlRiskCardProps {
  includeAml: boolean;
  setIncludeAml: (v: boolean) => void;
  doneRows: AddressRow[];
  isComputingAml: boolean;
  amlScreeningResult: AmlScreeningResult | null;
  amlPepStatus: "not-stated" | "yes" | "no";
  setAmlPepStatus: (v: "not-stated" | "yes" | "no") => void;
  amlSourceOfWealth: string;
  setAmlSourceOfWealth: (v: string) => void;
  amlSourceOfFunds: string;
  setAmlSourceOfFunds: (v: string) => void;
  amlTaxJurisdiction: string;
  setAmlTaxJurisdiction: (v: string) => void;
  amlTaxStatement: string;
  setAmlTaxStatement: (v: string) => void;
  attestationPreviewLines: string[];
}

export function AmlRiskCard({
  includeAml,
  setIncludeAml,
  doneRows,
  isComputingAml,
  amlScreeningResult,
  amlPepStatus,
  setAmlPepStatus,
  amlSourceOfWealth,
  setAmlSourceOfWealth,
  amlSourceOfFunds,
  setAmlSourceOfFunds,
  amlTaxJurisdiction,
  setAmlTaxJurisdiction,
  amlTaxStatement,
  setAmlTaxStatement,
  attestationPreviewLines,
}: AmlRiskCardProps) {
  return (<>
        {/* Step 7: AML / Risk Screening */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5" />
              Step 7 — AML / Risk Screening
              <Badge variant="secondary" className="ml-1 text-xs font-normal">Optional</Badge>
            </CardTitle>
            <CardDescription>
              Add an AML / Risk Screening appendix that screens the declared addresses against
              KYUTXO's bundled offline entity list and surfaces self-attestation lines for PEP status,
              source of wealth/funds, and tax residency. Off by default — when off, the PDF is unchanged.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="space-y-0.5">
                <Label htmlFor="include-aml" className="text-sm font-medium">
                  Include AML / Risk Screening appendix in the PDF
                </Label>
                <p className="text-sm text-muted-foreground">
                  Off by default. When on, adds a screening summary, attestation lines, and an
                  honesty disclaimer to the declaration.
                </p>
              </div>
              <Switch
                id="include-aml"
                checked={includeAml}
                onCheckedChange={setIncludeAml}
                data-testid="switch-include-aml"
              />
            </div>

            {includeAml && (
              <>
                <Separator />

                {doneRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    Check balances for at least one valid address (Step 2) to run screening.
                  </p>
                ) : (
                  <>
                    {/* Screening preview */}
                    <div className="rounded-md border bg-muted/30 px-4 py-3 space-y-2">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        {isComputingAml ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Running screening…
                          </>
                        ) : amlScreeningResult ? (
                          <>
                            <ShieldAlert className="h-4 w-4" />
                            Screening complete — {amlScreeningResult.screenedCount} address{amlScreeningResult.screenedCount !== 1 ? "es" : ""} checked
                          </>
                        ) : (
                          <>
                            <Shield className="h-4 w-4" />
                            Screening will run when you generate the PDF
                          </>
                        )}
                      </div>

                      {amlScreeningResult && (
                        <div className="space-y-1 text-xs text-muted-foreground">
                          <div>{buildEntityListDescription(amlScreeningResult)}</div>
                          {amlScreeningResult.directMatches.length === 0 ? (
                            <div className="text-green-600 dark:text-green-400 font-medium">
                              {AML_PREVIEW_STRINGS.noDirectMatches}
                            </div>
                          ) : (
                            <div className="text-destructive font-medium">
                              {buildPreviewDirectMatchLine(
                                amlScreeningResult.directMatches.length,
                                amlScreeningResult.directMatches.map(m => m.entityName),
                              )}
                            </div>
                          )}
                          {amlScreeningResult.hasGraphData ? (
                            amlScreeningResult.nearestHopDistance === null ? (
                              <div className="text-green-600 dark:text-green-400">
                                {AML_PREVIEW_STRINGS.noProximityMatch}
                              </div>
                            ) : (
                              <div>
                                {buildNearestEntityLine({
                                  nearestHopDistance: amlScreeningResult.nearestHopDistance,
                                  nearestHopEntityName: amlScreeningResult.nearestHopEntityName,
                                  nearestHopCategoryLabel: amlScreeningResult.nearestHopCategoryLabel,
                                })}
                              </div>
                            )
                          ) : (
                            <div className="text-muted-foreground">
                              {AML_PREVIEW_STRINGS.noGraphData}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Attestation inputs */}
                    <div className="space-y-4">
                      <h4 className="text-sm font-semibold">Declarant Self-Attestations</h4>
                      <p className="text-xs text-muted-foreground">
                        These fields are optional but recommended. They appear verbatim in the PDF attestation section.
                        Blank fields are noted as "not provided" in the PDF.
                      </p>

                      <div className="space-y-1">
                        <Label htmlFor="aml-pep-status" className="text-sm">
                          Politically Exposed Person (PEP) status
                        </Label>
                        <Select value={amlPepStatus} onValueChange={(v) => setAmlPepStatus(v as "not-stated" | "yes" | "no")}>
                          <SelectTrigger id="aml-pep-status" data-testid="select-aml-pep-status">
                            <SelectValue placeholder="Select…" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="not-stated">Not stated</SelectItem>
                            <SelectItem value="no">No — I am not a PEP</SelectItem>
                            <SelectItem value="yes">Yes — I am a PEP</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-1">
                        <Label htmlFor="aml-source-of-wealth" className="text-sm">
                          Source of Wealth <span className="text-muted-foreground text-xs">(how the declarant accumulated their overall wealth)</span>
                        </Label>
                        <Textarea
                          id="aml-source-of-wealth"
                          placeholder="e.g. Employment income, business ownership, property sale proceeds, inheritance…"
                          className="min-h-[72px] text-sm resize-none"
                          value={amlSourceOfWealth}
                          onChange={(e) => setAmlSourceOfWealth(e.target.value)}
                          data-testid="textarea-aml-source-of-wealth"
                        />
                      </div>

                      <div className="space-y-1">
                        <Label htmlFor="aml-source-of-funds" className="text-sm">
                          Source of Funds <span className="text-muted-foreground text-xs">(where these specific Bitcoin funds came from)</span>
                        </Label>
                        <Textarea
                          id="aml-source-of-funds"
                          placeholder="e.g. Purchased via regulated exchange using salary income, mined since 2015, received as payment for consulting services…"
                          className="min-h-[72px] text-sm resize-none"
                          value={amlSourceOfFunds}
                          onChange={(e) => setAmlSourceOfFunds(e.target.value)}
                          data-testid="textarea-aml-source-of-funds"
                        />
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-1">
                          <Label htmlFor="aml-tax-jurisdiction" className="text-sm">
                            Tax residency jurisdiction
                          </Label>
                          <Input
                            id="aml-tax-jurisdiction"
                            placeholder="e.g. United Kingdom, Germany, United States"
                            value={amlTaxJurisdiction}
                            onChange={(e) => setAmlTaxJurisdiction(e.target.value)}
                            data-testid="input-aml-tax-jurisdiction"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="aml-tax-statement" className="text-sm">
                            Tax compliance statement <span className="text-muted-foreground text-xs">(optional)</span>
                          </Label>
                          <Input
                            id="aml-tax-statement"
                            placeholder="e.g. All taxes have been duly filed and paid."
                            value={amlTaxStatement}
                            onChange={(e) => setAmlTaxStatement(e.target.value)}
                            data-testid="input-aml-tax-statement"
                          />
                        </div>
                      </div>
                    </div>

                    {/* Live attestation preview — mirrors the PDF section word-for-word */}
                    <div className="space-y-2 rounded-md border bg-muted/40 p-4" data-testid="preview-aml-attestation">
                      <h4 className="text-sm font-semibold">Attestation preview</h4>
                      <p className="text-xs text-muted-foreground">
                        These lines appear verbatim in the PDF's "Declarant Self-Attestations" section and
                        update as you type above.
                      </p>
                      <div className="space-y-1.5 text-xs">
                        {attestationPreviewLines.map((line, i) => (
                          <p key={i} className="leading-relaxed" data-testid={`text-aml-attestation-line-${i}`}>
                            {line}
                          </p>
                        ))}
                      </div>
                    </div>

                    <Alert>
                      <AlertCircle className="h-4 w-4" />
                      <AlertDescription className="text-xs space-y-1">
                        <p className="font-medium">Screening limitations</p>
                        <p>
                          This is a best-effort offline check against a bundled dataset of publicly documented
                          addresses. It is not a substitute for your institution's own KYC/AML procedures or
                          licensed chain-analysis tooling. A "no match" result does not guarantee the funds
                          are risk-free. The PDF clearly states these limitations.
                        </p>
                      </AlertDescription>
                    </Alert>
                  </>
                )}
              </>
            )}
          </CardContent>
        </Card>
  </>);
}
