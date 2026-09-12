// Step 3 (declarant details + live preview) and Step 4 (optional fiat
// equivalent) cards for the Proof of Funds page. Extracted verbatim from
// ProofOfFundsDeclaration.tsx with zero behavior change.
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type AddressRow, type BalanceSummary } from "./address-helpers";

export interface DeclarantPreviewRow {
  key: string;
  label: string;
  value: string;
  testid: string;
}

interface DeclarantDetailsCardProps {
  declarantName: string;
  setDeclarantName: (v: string) => void;
  declarantContact: string;
  setDeclarantContact: (v: string) => void;
  declarantResidentialAddress: string;
  setDeclarantResidentialAddress: (v: string) => void;
  declarantDob: string;
  setDeclarantDob: (v: string) => void;
  declarantTaxId: string;
  setDeclarantTaxId: (v: string) => void;
  declarantIdNumber: string;
  setDeclarantIdNumber: (v: string) => void;
  declarantNationality: string;
  setDeclarantNationality: (v: string) => void;
  declarationDate: string;
  setDeclarationDate: (v: string) => void;
  purpose: string;
  setPurpose: (v: string) => void;
  statement: string;
  setStatement: (v: string) => void;
  declarantPreviewRows: DeclarantPreviewRow[];
}

export function DeclarantDetailsCard({
  declarantName,
  setDeclarantName,
  declarantContact,
  setDeclarantContact,
  declarantResidentialAddress,
  setDeclarantResidentialAddress,
  declarantDob,
  setDeclarantDob,
  declarantTaxId,
  setDeclarantTaxId,
  declarantIdNumber,
  setDeclarantIdNumber,
  declarantNationality,
  setDeclarantNationality,
  declarationDate,
  setDeclarationDate,
  purpose,
  setPurpose,
  statement,
  setStatement,
  declarantPreviewRows,
}: DeclarantDetailsCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Step 3 — Declarant Details</CardTitle>
        <CardDescription>
          These details appear in the declaration header and signature block.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="declarant-name">Full Name <span className="text-destructive">*</span></Label>
            <Input
              id="declarant-name"
              placeholder="Your full legal name"
              value={declarantName}
              onChange={(e) => setDeclarantName(e.target.value)}
              data-testid="input-declarant-name"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="declaration-date">Declaration Date <span className="text-destructive">*</span></Label>
            <Input
              id="declaration-date"
              type="date"
              value={declarationDate}
              onChange={(e) => setDeclarationDate(e.target.value)}
              data-testid="input-declaration-date"
            />
          </div>
        </div>

        <div className="space-y-1">
          <Label htmlFor="declarant-contact">Contact / Address <span className="text-muted-foreground text-xs">(optional)</span></Label>
          <Input
            id="declarant-contact"
            placeholder="Email, postal address, or other contact information"
            value={declarantContact}
            onChange={(e) => setDeclarantContact(e.target.value)}
            data-testid="input-declarant-contact"
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="declarant-residential-address">Residential / Street Address <span className="text-muted-foreground text-xs">(optional)</span></Label>
          <Input
            id="declarant-residential-address"
            placeholder="Street address, city, state / country"
            value={declarantResidentialAddress}
            onChange={(e) => setDeclarantResidentialAddress(e.target.value)}
            data-testid="input-declarant-residential-address"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="declarant-dob">Date of Birth <span className="text-muted-foreground text-xs">(optional)</span></Label>
            <Input
              id="declarant-dob"
              type="date"
              value={declarantDob}
              onChange={(e) => setDeclarantDob(e.target.value)}
              data-testid="input-declarant-dob"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="declarant-nationality">Nationality <span className="text-muted-foreground text-xs">(optional)</span></Label>
            <Input
              id="declarant-nationality"
              placeholder="e.g. United States"
              value={declarantNationality}
              onChange={(e) => setDeclarantNationality(e.target.value)}
              data-testid="input-declarant-nationality"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="declarant-tax-id">Tax ID Number <span className="text-muted-foreground text-xs">(optional)</span></Label>
            <Input
              id="declarant-tax-id"
              placeholder="e.g. SSN, EIN, TIN"
              value={declarantTaxId}
              onChange={(e) => setDeclarantTaxId(e.target.value)}
              data-testid="input-declarant-tax-id"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="declarant-id-number">Identification Number <span className="text-muted-foreground text-xs">(optional)</span></Label>
            <Input
              id="declarant-id-number"
              placeholder="e.g. Passport or national ID number"
              value={declarantIdNumber}
              onChange={(e) => setDeclarantIdNumber(e.target.value)}
              data-testid="input-declarant-id-number"
            />
          </div>
        </div>

        <div className="space-y-1">
          <Label htmlFor="purpose">Purpose <span className="text-destructive">*</span></Label>
          <Input
            id="purpose"
            placeholder="e.g. Proof of funds for a residential property purchase"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            data-testid="input-purpose"
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="statement">Declaration Statement <span className="text-muted-foreground text-xs">(optional)</span></Label>
          <Textarea
            id="statement"
            placeholder="I, the undersigned, hereby declare that I am the sole owner of the Bitcoin addresses listed in this document and that the balances shown represent funds under my direct control..."
            className="min-h-[100px]"
            value={statement}
            onChange={(e) => setStatement(e.target.value)}
            data-testid="textarea-statement"
          />
        </div>

        {/* Live preview of the declarant details that will appear in the PDF.
            Optional identity fields only show when filled (mirrors the PDF). */}
        {declarantPreviewRows.length > 0 && (
          <div
            className="rounded-md border bg-muted/30 p-4 space-y-2"
            data-testid="declarant-preview"
          >
            <h4 className="text-sm font-semibold">Declaration Preview</h4>
            <p className="text-xs text-muted-foreground">
              This is how the declarant details will appear in the PDF. Blank optional fields are omitted.
            </p>
            <dl className="space-y-1 text-sm">
              {declarantPreviewRows.map((row) => (
                <div
                  key={row.key}
                  className="flex flex-wrap gap-x-2"
                  data-testid={`preview-row-${row.key}`}
                >
                  <dt className="text-muted-foreground">{row.label}</dt>
                  <dd className="font-medium break-all" data-testid={row.testid}>
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface FiatEquivalentCardProps {
  fiatCurrency: string;
  setFiatCurrency: (v: string) => void;
  fiatRate: string;
  setFiatRate: (v: string) => void;
  fiatValid: boolean;
  fiatTotal: number | null;
  summary: BalanceSummary | null;
  doneRows: AddressRow[];
}

export function FiatEquivalentCard({
  fiatCurrency,
  setFiatCurrency,
  fiatRate,
  setFiatRate,
  fiatValid,
  fiatTotal,
  summary,
  doneRows,
}: FiatEquivalentCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Step 4 — Fiat Equivalent <span className="text-muted-foreground font-normal text-base">(Optional)</span></CardTitle>
        <CardDescription>
          Enter an exchange rate and currency to include a fiat equivalent in the PDF.
          The rate is supplied by you — it is not fetched from any market feed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="fiat-currency">Currency</Label>
            <Select value={fiatCurrency} onValueChange={setFiatCurrency}>
              <SelectTrigger id="fiat-currency" data-testid="select-fiat-currency">
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
          </div>
          <div className="space-y-1">
            <Label htmlFor="fiat-rate">Exchange Rate (BTC per 1 {fiatCurrency})</Label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground whitespace-nowrap">1 BTC =</span>
              <Input
                id="fiat-rate"
                type="number"
                min="0"
                step="any"
                placeholder="e.g. 65000"
                value={fiatRate}
                onChange={(e) => setFiatRate(e.target.value)}
                data-testid="input-fiat-rate"
              />
              <span className="text-sm text-muted-foreground">{fiatCurrency}</span>
            </div>
          </div>
        </div>

        {fiatValid && summary && doneRows.length > 0 && fiatTotal !== null && (
          <div className="rounded-md border bg-muted/30 px-4 py-3 text-sm space-y-1">
            <div className="font-medium">
              Fiat Equivalent: {fiatTotal.toLocaleString("en-US", {
                style: "currency",
                currency: fiatCurrency,
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })} {fiatCurrency}
            </div>
            <div className="text-xs text-muted-foreground">
              Rate supplied by declarant — not a market quote or financial advice.
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
