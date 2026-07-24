// Step 1 (address input), Step 2 (balance source + run controls), and the
// Balance Results card for the Proof of Funds page. Extracted verbatim from
// ProofOfFundsDeclaration.tsx with zero behavior change.
import {
  Loader2,
  AlertCircle,
  CheckCircle,
  Clock,
  X,
  RefreshCw,
  Wifi,
  Database,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBTC } from "@/lib/bitcoin";
import {
  type BalanceSource,
  type AddressRow,
  type BalanceSummary,
} from "./address-helpers";

interface AddressInputCardProps {
  addressTab: "paste" | "vault";
  setAddressTab: (tab: "paste" | "vault") => void;
  pastedText: string;
  setPastedText: (text: string) => void;
  filterOwner: string;
  setFilterOwner: (owner: string) => void;
  filterWallet: string;
  setFilterWallet: (wallet: string) => void;
  isChecking: boolean;
  owners: { name: string }[];
  walletNames: { name: string }[];
}

export function AddressInputCard({
  addressTab,
  setAddressTab,
  pastedText,
  setPastedText,
  filterOwner,
  setFilterOwner,
  filterWallet,
  setFilterWallet,
  isChecking,
  owners,
  walletNames,
}: AddressInputCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Step 1 — Bitcoin Addresses</CardTitle>
        <CardDescription>
          Enter addresses by pasting a list, or select from your vault by owner or wallet.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Tabs value={addressTab} onValueChange={(v) => setAddressTab(v as "paste" | "vault")}>
          <TabsList>
            <TabsTrigger value="paste" data-testid="tab-paste-addresses">Paste List</TabsTrigger>
            <TabsTrigger value="vault" data-testid="tab-vault-addresses">From Vault</TabsTrigger>
          </TabsList>

          <TabsContent value="paste" className="space-y-2 mt-3">
            <Textarea
              placeholder={`bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh\nbc1q...\n1A1zP1...`}
              className="min-h-[120px] font-mono text-sm"
              value={pastedText}
              onChange={(e) => setPastedText(e.target.value)}
              disabled={isChecking}
              data-testid="textarea-address-input"
            />
            <p className="text-xs text-muted-foreground">
              Separate addresses with newlines, commas, or semicolons. Duplicates are removed automatically.
            </p>
          </TabsContent>

          <TabsContent value="vault" className="space-y-3 mt-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>Filter by Owner</Label>
                <Select value={filterOwner} onValueChange={setFilterOwner} disabled={isChecking}>
                  <SelectTrigger data-testid="select-filter-owner">
                    <SelectValue placeholder="All owners" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All owners</SelectItem>
                    {owners.map((o) => (
                      <SelectItem key={o.name} value={o.name}>{o.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Filter by Wallet</Label>
                <Select value={filterWallet} onValueChange={setFilterWallet} disabled={isChecking}>
                  <SelectTrigger data-testid="select-filter-wallet">
                    <SelectValue placeholder="All wallets" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All wallets</SelectItem>
                    {walletNames.map((w) => (
                      <SelectItem key={w.name} value={w.name}>{w.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              All address records matching the selected filters will be included.
            </p>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

interface BalanceSourceCardProps {
  balanceSource: BalanceSource;
  setBalanceSource: (source: BalanceSource) => void;
  isChecking: boolean;
  addressTab: "paste" | "vault";
  pastedText: string;
  hasResults: boolean;
  validCount: number;
  doneCount: number;
  providerError: string | null;
  runCheck: () => void;
  handleCancel: () => void;
  handleReset: () => void;
}

export function BalanceSourceCard({
  balanceSource,
  setBalanceSource,
  isChecking,
  addressTab,
  pastedText,
  hasResults,
  validCount,
  doneCount,
  providerError,
  runCheck,
  handleCancel,
  handleReset,
}: BalanceSourceCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Step 2 — Balance Source</CardTitle>
        <CardDescription>
          Choose how balances are resolved for each address.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setBalanceSource("offline")}
            disabled={isChecking}
            data-testid="button-source-offline"
            className={`flex items-start gap-3 rounded-md border p-4 text-left transition-colors ${
              balanceSource === "offline"
                ? "border-primary bg-primary/5"
                : "border-border hover-elevate"
            }`}
          >
            <Database className={`h-5 w-5 mt-0.5 shrink-0 ${balanceSource === "offline" ? "text-primary" : "text-muted-foreground"}`} />
            <div>
              <div className="font-medium text-sm">Offline Vault Data</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Use already-synced data from your vault. No network required. Shows last-sync timestamp.
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => setBalanceSource("live")}
            disabled={isChecking}
            data-testid="button-source-live"
            className={`flex items-start gap-3 rounded-md border p-4 text-left transition-colors ${
              balanceSource === "live"
                ? "border-primary bg-primary/5"
                : "border-border hover-elevate"
            }`}
          >
            <Wifi className={`h-5 w-5 mt-0.5 shrink-0 ${balanceSource === "live" ? "text-primary" : "text-muted-foreground"}`} />
            <div>
              <div className="font-medium text-sm">Live On-Chain Check</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Query your configured node for real-time balances. Shows block height and timestamp.
              </div>
            </div>
          </button>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Button
            onClick={runCheck}
            disabled={isChecking || (addressTab === "paste" && !pastedText.trim())}
            data-testid="button-check-balances"
          >
            {isChecking ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Checking…
              </>
            ) : (
              <>
                <RefreshCw className="h-4 w-4 mr-2" />
                Check Balances
              </>
            )}
          </Button>

          {isChecking && (
            <Button variant="outline" onClick={handleCancel} data-testid="button-cancel-check">
              <X className="h-4 w-4 mr-2" />
              Cancel
            </Button>
          )}

          {hasResults && !isChecking && (
            <Button variant="outline" onClick={handleReset} data-testid="button-reset">
              <RefreshCw className="h-4 w-4 mr-2" />
              Reset
            </Button>
          )}

          {isChecking && validCount > 0 && balanceSource === "live" && (
            <span className="text-sm text-muted-foreground" data-testid="text-check-progress">
              {doneCount} / {validCount} done
            </span>
          )}
        </div>

        {providerError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {providerError}{" "}
              <Link
                href="/node-settings"
                className="font-medium underline underline-offset-2"
                data-testid="link-node-settings"
              >
                Check Node Connection settings
              </Link>
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

interface BalanceResultsCardProps {
  summary: BalanceSummary | null;
  dupes: number;
  validRows: AddressRow[];
  invalidRows: AddressRow[];
  doneRows: AddressRow[];
  emptyRows: AddressRow[];
  errorRows: AddressRow[];
  isChecking: boolean;
  balanceSource: BalanceSource;
  totalSats: number;
  fiatValid: boolean;
  fiatTotal: number | null;
  fiatCurrency: string;
}

export function BalanceResultsCard({
  summary,
  dupes,
  validRows,
  invalidRows,
  doneRows,
  emptyRows,
  errorRows,
  isChecking,
  balanceSource,
  totalSats,
  fiatValid,
  fiatTotal,
  fiatCurrency,
}: BalanceResultsCardProps) {
  const [showInvalid, setShowInvalid] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Balance Results</CardTitle>
        {summary && (
          <CardDescription data-testid="text-data-source-note">
            {summary.asOfLabel}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {dupes > 0 && (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {dupes} duplicate address{dupes !== 1 ? "es were" : " was"} removed.
            </AlertDescription>
          </Alert>
        )}

        {validRows.filter((r) => r.status !== "empty").length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Address</TableHead>
                <TableHead className="text-right">Balance (BTC)</TableHead>
                <TableHead className="w-28">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {validRows.filter((r) => r.status !== "empty").map((row, idx) => (
                <TableRow key={idx} data-testid={`row-address-${idx}`}>
                  <TableCell className="font-mono text-xs break-all">
                    {row.raw}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {row.status === "done"
                      ? formatBTC(row.balanceSats ?? 0)
                      : <span className="text-muted-foreground">—</span>
                    }
                  </TableCell>
                  <TableCell>
                    {row.status === "pending" && (
                      <Badge variant="secondary" className="gap-1">
                        <Clock className="h-3 w-3" />
                        Pending
                      </Badge>
                    )}
                    {row.status === "loading" && (
                      <Badge variant="secondary" className="gap-1">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Checking
                      </Badge>
                    )}
                    {row.status === "done" && (
                      <Badge variant="secondary" className="gap-1 text-green-600 dark:text-green-400">
                        <CheckCircle className="h-3 w-3" />
                        Done
                      </Badge>
                    )}
                    {row.status === "error" && (
                      <Badge variant="destructive" className="gap-1" title={row.error}>
                        <AlertCircle className="h-3 w-3" />
                        Error
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {doneRows.length === 0 && emptyRows.length > 0 && !isChecking && (
          <Alert data-testid="alert-all-empty">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              All {emptyRows.length} address{emptyRows.length !== 1 ? "es" : ""} resolved to a zero balance and were excluded. There is nothing to declare.
            </AlertDescription>
          </Alert>
        )}

        {doneRows.length > 0 && (
          <div className="flex items-center justify-between rounded-md border bg-muted/30 px-4 py-3">
            <span className="font-semibold text-sm">Total Balance</span>
            <div className="text-right">
              <div className="font-bold font-mono tabular-nums" data-testid="text-total-balance">
                {formatBTC(totalSats)} BTC
              </div>
              {fiatValid && fiatTotal !== null && (
                <div className="text-sm text-muted-foreground font-mono tabular-nums" data-testid="text-fiat-total">
                  ≈ {fiatTotal.toLocaleString("en-US", {
                    style: "currency",
                    currency: fiatCurrency,
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })} {fiatCurrency}
                </div>
              )}
            </div>
          </div>
        )}

        {emptyRows.length > 0 && doneRows.length > 0 && (
          <Alert data-testid="alert-empty-excluded">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {emptyRows.length} empty address{emptyRows.length !== 1 ? "es" : ""} excluded — {emptyRows.length !== 1 ? "these addresses have" : "this address has"} a zero balance and will not appear in the declaration.
            </AlertDescription>
          </Alert>
        )}

        {invalidRows.length > 0 && (
          <div className="rounded-md border border-destructive/30">
            <button
              type="button"
              onClick={() => setShowInvalid((v) => !v)}
              className="flex w-full items-center justify-between px-4 py-2 text-sm font-medium text-destructive hover-elevate rounded-md"
              data-testid="button-toggle-invalid"
            >
              <span className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4" />
                {invalidRows.length} invalid address{invalidRows.length !== 1 ? "es" : ""} (excluded from declaration)
              </span>
              {showInvalid ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
            {showInvalid && (
              <div className="border-t px-4 pb-3 pt-2 space-y-1">
                {invalidRows.map((r, idx) => (
                  <div key={idx} className="flex items-start gap-2 text-xs">
                    <AlertCircle className="h-3 w-3 text-destructive mt-0.5 shrink-0" />
                    <span className="font-mono text-destructive break-all">{r.raw}</span>
                    <span className="text-muted-foreground shrink-0">— {r.invalidReason}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {errorRows.length > 0 && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {errorRows.length} address{errorRows.length !== 1 ? "es" : ""} failed to load
              {balanceSource === "live" ? " — check your Node Connection settings." : "."}
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
