import { QrCode as QrCodeIcon, Clock, Globe, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatBTC } from "@/lib/bitcoin";
import { type AddressRow } from "./address-helpers";
import { type ExplorerId, QR_EXPLORERS, getExplorer } from "./explorer-helpers";

interface QrCodesCardProps {
  includeQr: boolean;
  setIncludeQr: (v: boolean) => void;
  doneRows: AddressRow[];
  qrExplorerId: ExplorerId;
  setQrExplorerId: (id: ExplorerId) => void;
  qrPreviews: Record<string, string>;
}

export function QrCodesCard({
  includeQr,
  setIncludeQr,
  doneRows,
  qrExplorerId,
  setQrExplorerId,
  qrPreviews,
}: QrCodesCardProps) {
  return (<>
        {/* Step 6: Balance-Verification QR Codes */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <QrCodeIcon className="h-5 w-5" />
              Step 6 — Verification QR Codes
              <Badge variant="secondary" className="ml-1 text-xs font-normal">Optional</Badge>
            </CardTitle>
            <CardDescription>
              Add a QR code for each address so the recipient can scan it and look up the
              balance on a public block explorer. The codes are drawn entirely offline —
              KYUTXO never contacts the explorer. They simply encode a link the recipient
              can choose to open (which requires their own internet connection).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="space-y-0.5">
                <Label htmlFor="include-qr" className="text-sm font-medium">
                  Include verification QR codes in the PDF
                </Label>
                <p className="text-sm text-muted-foreground">
                  Adds one QR code per address with a checked balance.
                </p>
              </div>
              <Switch
                id="include-qr"
                checked={includeQr}
                onCheckedChange={setIncludeQr}
                data-testid="switch-include-qr"
              />
            </div>

            {includeQr && (
              <>
                <Separator />

                {doneRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    Check balances for at least one valid address (Step 2) to generate codes.
                  </p>
                ) : (
                  <>
                    <div className="space-y-2 max-w-xs">
                      <Label htmlFor="qr-explorer" className="text-sm">Block explorer</Label>
                      <Select
                        value={qrExplorerId}
                        onValueChange={(v) => setQrExplorerId(v as ExplorerId)}
                      >
                        <SelectTrigger id="qr-explorer" data-testid="select-qr-explorer">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {QR_EXPLORERS.map((e) => (
                            <SelectItem key={e.id} value={e.id} data-testid={`option-explorer-${e.id}`}>
                              {e.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        Each code links to{" "}
                        <span className="font-mono">{getExplorer(qrExplorerId).host}</span>.
                      </p>
                    </div>

                    <Alert>
                      <Globe className="h-4 w-4" />
                      <AlertDescription>
                        Scanning a code opens a third-party block explorer and shares the
                        address with it. The recipient needs their own internet connection;
                        KYUTXO stays fully offline.
                      </AlertDescription>
                    </Alert>

                    <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
                      {doneRows.map((r) => (
                        <div
                          key={r.raw}
                          className="flex flex-col items-center gap-2 rounded-md border p-3 text-center"
                          data-testid={`qr-preview-${r.raw}`}
                        >
                          {qrPreviews[r.raw] ? (
                            <img
                              src={qrPreviews[r.raw]}
                              alt={`QR code linking to ${r.raw}`}
                              className="h-32 w-32"
                              data-testid={`qr-image-${r.raw}`}
                            />
                          ) : (
                            <div className="h-32 w-32 flex items-center justify-center text-muted-foreground">
                              <Loader2 className="h-5 w-5 animate-spin" />
                            </div>
                          )}
                          <span className="font-mono text-xs break-all" title={r.raw}>
                            {r.raw.length > 20 ? `${r.raw.slice(0, 10)}…${r.raw.slice(-8)}` : r.raw}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {formatBTC(r.balanceSats ?? 0)} BTC
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </CardContent>
        </Card>
  </>);
}
