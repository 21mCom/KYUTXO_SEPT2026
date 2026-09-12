import { ClipboardCheck, FileText } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { DECLARATION_INTRO_PARAGRAPHS } from "./declaration-prefs";

interface AttestationCardProps {
  includeAttestation: boolean;
  setIncludeAttestation: (v: boolean) => void;
  attestationPlaceOfSigning: string;
  setAttestationPlaceOfSigning: (v: string) => void;
  attestationWitnessLine: string;
  setAttestationWitnessLine: (v: string) => void;
}

export function AttestationCard({
  includeAttestation,
  setIncludeAttestation,
  attestationPlaceOfSigning,
  setAttestationPlaceOfSigning,
  attestationWitnessLine,
  setAttestationWitnessLine,
}: AttestationCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ClipboardCheck className="h-5 w-5" />
          Step 9 — Formal Attestation
          <Badge variant="secondary" className="ml-1 text-xs font-normal">Optional</Badge>
        </CardTitle>
        <CardDescription>
          Add a formal attestation block with a solemn declaration statement, a signature line,
          place of signing, and an optional witness or notary line. Off by default — the always-on
          document integrity section (reference ID, content fingerprint, page numbers, blockchain
          time-anchor) is included in every PDF regardless of this toggle.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="space-y-0.5">
            <Label htmlFor="include-attestation" className="text-sm font-medium">
              Include formal attestation block in the PDF
            </Label>
            <p className="text-sm text-muted-foreground">
              Off by default. When on, adds a solemn declaration statement with a signature line,
              date, place of signing, and an optional witness/notary block.
            </p>
          </div>
          <Switch
            id="include-attestation"
            checked={includeAttestation}
            onCheckedChange={setIncludeAttestation}
            data-testid="switch-include-attestation"
          />
        </div>

        {includeAttestation && (
          <>
            <Separator />
            <div className="rounded-md border bg-muted/30 px-4 py-3 space-y-1 text-sm">
              <div className="font-medium text-sm">Attestation statement (printed verbatim)</div>
              <p className="text-xs text-muted-foreground italic">
                "I, [your name], hereby solemnly declare and attest that the foregoing information —
                including all Bitcoin addresses, reported balances, and supporting details — is true,
                accurate, and complete to the best of my knowledge and belief. I am the lawful owner
                or authorised signatory of the declared addresses and the funds associated with them.
                I understand that knowingly making a false declaration may result in civil and/or
                criminal liability under applicable law."
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="attestation-place" className="text-sm">
                  Place of signing <span className="text-muted-foreground text-xs">(optional)</span>
                </Label>
                <Input
                  id="attestation-place"
                  placeholder="e.g. London, United Kingdom"
                  value={attestationPlaceOfSigning}
                  onChange={(e) => setAttestationPlaceOfSigning(e.target.value)}
                  data-testid="input-attestation-place"
                />
                <p className="text-xs text-muted-foreground">
                  If blank, a blank signature line is printed instead.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="attestation-witness" className="text-sm">
                  Witness / Notary line <span className="text-muted-foreground text-xs">(optional)</span>
                </Label>
                <Input
                  id="attestation-witness"
                  placeholder="e.g. John Smith, Solicitor, Law Society No. 12345"
                  value={attestationWitnessLine}
                  onChange={(e) => setAttestationWitnessLine(e.target.value)}
                  data-testid="input-attestation-witness"
                />
                <p className="text-xs text-muted-foreground">
                  If blank, blank witness/notary signature lines are printed.
                </p>
              </div>
            </div>
            <div className="rounded-md border bg-muted/30 px-4 py-3 space-y-1 text-xs text-muted-foreground">
              <p className="font-medium text-foreground text-sm">Always included in every PDF (no toggle needed)</p>
              <ul className="list-disc list-inside space-y-0.5">
                <li>Page X of Y footer with declaration reference ID on every page</li>
                <li>Generation metadata: tool name, generation date/time</li>
                <li>Content fingerprint: SHA-256 of key declaration fields</li>
                <li>Blockchain time-anchor: block height and timestamp from your balance data</li>
              </ul>
            </div>
          </>
        )}

        {!includeAttestation && (
          <div className="rounded-md border bg-muted/30 px-4 py-3 space-y-1 text-xs text-muted-foreground">
            <p className="font-medium text-foreground text-sm">Always included in every PDF</p>
            <ul className="list-disc list-inside space-y-0.5">
              <li>Page X of Y footer with declaration reference ID on every page</li>
              <li>Generation metadata: tool name, generation date/time</li>
              <li>Content fingerprint: SHA-256 of key declaration fields</li>
              <li>Blockchain time-anchor: block height and timestamp from your balance data</li>
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface GlossaryCardProps {
  includeGlossary: boolean;
  setIncludeGlossary: (v: boolean) => void;
}

export function GlossaryCard({ includeGlossary, setIncludeGlossary }: GlossaryCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="h-5 w-5" />
          Step 10 — Glossary
          <Badge variant="secondary" className="ml-1 text-xs font-normal">Optional</Badge>
        </CardTitle>
        <CardDescription>
          Append a plain-language glossary of Bitcoin and compliance terms for non-technical reviewers.
          Covers Bitcoin addresses, UTXO, xpub, confirmations, hops, SHA-256, PEP, AML, and more.
          Off by default — when off, the PDF is unchanged.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="space-y-0.5">
            <Label htmlFor="include-glossary" className="text-sm font-medium">
              Include glossary appendix in the PDF
            </Label>
            <p className="text-sm text-muted-foreground">
              Off by default. When on, adds a final appendix defining Bitcoin, Address, UTXO, xpub,
              Confirmation, Hop, SHA-256, PEP, AML, KYC, and other terms used in this document.
            </p>
          </div>
          <Switch
            id="include-glossary"
            checked={includeGlossary}
            onCheckedChange={setIncludeGlossary}
            data-testid="switch-include-glossary"
          />
        </div>

        {includeGlossary && (
          <>
            <Separator />
            <div className="rounded-md border bg-muted/30 px-4 py-3 text-xs text-muted-foreground space-y-1">
              <p className="font-medium text-foreground text-sm">Terms covered</p>
              <p>Bitcoin, Bitcoin Address, Balance, BTC, Satoshi, Blockchain, Block, Confirmation,
              UTXO, xpub, Proof of Control, Bitcoin Signed Message, BIP-322, Hop, SHA-256,
              Declaration Reference (Nonce), PEP, AML, KYC</p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

interface IntroCardProps {
  includeIntro: boolean;
  setIncludeIntro: (v: boolean) => void;
}

export function IntroCard({ includeIntro, setIncludeIntro }: IntroCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="h-5 w-5" />
          Step 11 — Introduction / Preface
          <Badge variant="secondary" className="ml-1 text-xs font-normal">Optional</Badge>
        </CardTitle>
        <CardDescription>
          Add a short plain-language preface to the very top of the PDF: that Bitcoin is a digital
          bearer asset, that the blockchain is a publicly verifiable ledger, and that ownership is
          established through control of the private keys.
          Off by default — when off, the PDF is unchanged.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="space-y-0.5">
            <Label htmlFor="include-intro" className="text-sm font-medium">
              Include introduction / preface in the PDF
            </Label>
            <p className="text-sm text-muted-foreground">
              Off by default. When on, adds an Introduction section at the top of the declaration,
              before the declarant details.
            </p>
          </div>
          <Switch
            id="include-intro"
            checked={includeIntro}
            onCheckedChange={setIncludeIntro}
            data-testid="switch-include-intro"
          />
        </div>

        {includeIntro && (
          <>
            <Separator />
            <div
              className="rounded-md border bg-muted/30 px-4 py-3 text-xs text-muted-foreground space-y-2"
              data-testid="text-intro-preview"
            >
              <p className="font-medium text-foreground text-sm">Preview</p>
              {DECLARATION_INTRO_PARAGRAPHS.map((paragraph, i) => (
                <p key={i}>{paragraph}</p>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
