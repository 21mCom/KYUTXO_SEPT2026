import { useState, useCallback, useMemo } from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Copy,
  ClipboardCheck,
  Download,
  Loader2,
  RefreshCw,
  Shield,
  ShieldCheck,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNodeSettings } from "@/hooks/use-node-settings";
import { createProviderFromSettings } from "@/lib/blockchain-api";
import {
  isValidBlockHash,
  isValidBlockHeight,
  blockHashInputError,
  blockHeightInputError,
} from "@/lib/block-validation";
import {
  buildChallengeMessage,
  verifyBitcoinSignature,
  signatureFormatLabel,
  type FreshnessAnchor,
} from "@/lib/signatureVerify";
import type { AddressRow, ControlState, ControlStatus } from "./address-helpers";

interface ProofOfControlCardProps {
  doneRows: AddressRow[];
  declarantInfoComplete: boolean;
  declarantName: string;
  declarationDate: string;
  purpose: string;
  declarationNonce: string;
  verifiedCount: number;
  controlStates: Record<string, ControlState>;
  setControlStates: React.Dispatch<React.SetStateAction<Record<string, ControlState>>>;
  verifierReference: string;
  setVerifierReference: (v: string) => void;
  freshnessAnchorEnabled: boolean;
  setFreshnessAnchorEnabled: (v: boolean) => void;
  freshnessAnchor: FreshnessAnchor | null;
  setFreshnessAnchor: (v: FreshnessAnchor | null) => void;
}

export function ProofOfControlCard({
  doneRows,
  declarantInfoComplete,
  declarantName,
  declarationDate,
  purpose,
  declarationNonce,
  verifiedCount,
  controlStates,
  setControlStates,
  verifierReference,
  setVerifierReference,
  freshnessAnchorEnabled,
  setFreshnessAnchorEnabled,
  freshnessAnchor,
  setFreshnessAnchor,
}: ProofOfControlCardProps) {
  const { nodeSettings } = useNodeSettings();

  // Track which addresses' challenge messages have been copied
  const [copiedAddresses, setCopiedAddresses] = useState<Set<string>>(new Set());

  // Optional add-ons for Step 5 (both off by default)
  const [proofAddonsOpen, setProofAddonsOpen] = useState(false);
  const [freshnessAnchorFetching, setFreshnessAnchorFetching] = useState(false);
  const [freshnessAnchorError, setFreshnessAnchorError] = useState<string | null>(null);
  const [freshnessManualHeight, setFreshnessManualHeight] = useState("");
  const [freshnessManualHash, setFreshnessManualHash] = useState("");

  // Fetch current block height + hash for the freshness anchor
  const fetchFreshnessAnchor = useCallback(async () => {
    setFreshnessAnchorFetching(true);
    setFreshnessAnchorError(null);
    setFreshnessAnchor(null);
    try {
      const provider = createProviderFromSettings(nodeSettings);
      const height = await provider.getBlockHeight();
      let hash: string;
      if (provider.getTipBlockHash) {
        hash = (await provider.getTipBlockHash()).trim();
      } else {
        throw new Error("Connected provider does not support block-hash lookup. Use the manual entry below.");
      }
      const fetchedAt = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
      setFreshnessAnchor({ height, hash, fetchedAt });
      setFreshnessManualHeight(String(height));
      setFreshnessManualHash(hash);
    } catch (err) {
      setFreshnessAnchorError(err instanceof Error ? err.message : "Failed to fetch block data.");
    } finally {
      setFreshnessAnchorFetching(false);
    }
  }, [nodeSettings, setFreshnessAnchor]);

  // Validate the manually-entered freshness anchor inputs
  const freshnessManualHeightError = useMemo(
    () => blockHeightInputError(freshnessManualHeight),
    [freshnessManualHeight],
  );

  const freshnessManualHashError = useMemo(
    () => blockHashInputError(freshnessManualHash),
    [freshnessManualHash],
  );

  const canApplyManualFreshnessAnchor =
    isValidBlockHeight(freshnessManualHeight) &&
    isValidBlockHash(freshnessManualHash);

  // Apply manually-entered height + hash as the freshness anchor
  const applyManualFreshnessAnchor = useCallback(() => {
    const raw = freshnessManualHeight.trim();
    const hash = freshnessManualHash.trim();
    if (!isValidBlockHeight(raw)) return;
    const h = parseInt(raw, 10);
    if (!isValidBlockHash(hash)) return;
    const fetchedAt = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
    setFreshnessAnchor({ height: h, hash, fetchedAt });
    setFreshnessAnchorError(null);
  }, [freshnessManualHeight, freshnessManualHash, setFreshnessAnchor]);

  const handleCopyChallenge = useCallback(
    (address: string) => {
      const msg = buildChallengeMessage({
        address,
        declarantName,
        declarationDate,
        purpose,
        nonce: declarationNonce,
        verifierReference: verifierReference || undefined,
        freshnessAnchor: freshnessAnchor ?? undefined,
      });
      navigator.clipboard.writeText(msg).then(() => {
        setCopiedAddresses((prev) => new Set(prev).add(address));
        setTimeout(() => {
          setCopiedAddresses((prev) => {
            const next = new Set(prev);
            next.delete(address);
            return next;
          });
        }, 2000);
      });
    },
    [declarantName, declarationDate, purpose, declarationNonce, verifierReference, freshnessAnchor]
  );

  // Per-address: update pasted signature text
  const handleSignaturePaste = useCallback((address: string, value: string) => {
    setControlStates((prev) => ({
      ...prev,
      [address]: { ...prev[address], paste: value, status: "idle", error: undefined, verifiedSig: undefined },
    }));
  }, [setControlStates]);

  // Per-address: verify pasted signature
  const handleVerify = useCallback(
    async (address: string) => {
      const cs = controlStates[address];
      const paste = cs?.paste?.trim() ?? "";
      if (!paste) {
        setControlStates((prev) => ({
          ...prev,
          [address]: { ...prev[address], status: "failed", error: "Paste a signature first." },
        }));
        return;
      }

      setControlStates((prev) => ({
        ...prev,
        [address]: { ...prev[address], status: "verifying", error: undefined },
      }));

      const message = buildChallengeMessage({
        address,
        declarantName,
        declarationDate,
        purpose,
        nonce: declarationNonce,
        verifierReference: verifierReference || undefined,
        freshnessAnchor: freshnessAnchor ?? undefined,
      });

      try {
        const result = await verifyBitcoinSignature(address, message, paste);
        if (result.verified) {
          setControlStates((prev) => ({
            ...prev,
            [address]: { paste, status: "verified", verifiedSig: paste, verifiedFormat: result.format },
          }));
        } else {
          setControlStates((prev) => ({
            ...prev,
            [address]: { paste, status: "failed", error: result.error },
          }));
        }
      } catch (err) {
        setControlStates((prev) => ({
          ...prev,
          [address]: {
            paste,
            status: "failed",
            error: err instanceof Error ? err.message : "Verification failed unexpectedly.",
          },
        }));
      }
    },
    [controlStates, setControlStates, declarantName, declarationDate, purpose, declarationNonce, verifierReference, freshnessAnchor]
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Shield className="h-5 w-5" />
          Step 5 — Proof of Control
          <Badge variant="secondary" className="ml-1 text-xs font-normal">Optional</Badge>
        </CardTitle>
        <CardDescription>
          Strengthen the declaration by proving cryptographic control of each address.
          Sign the challenge message below in your own wallet, then paste the resulting
          signature here. No private keys are shared with KYUTXO — only the address,
          message, and signature are used for verification.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!declarantInfoComplete && (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Complete Step 3 (declarant name, date, and purpose) first so the challenge message
              can be generated. Any signatures you collect must match that exact message.
            </AlertDescription>
          </Alert>
        )}

        {doneRows.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Check balances for at least one valid address (Step 2) to unlock this step.
          </p>
        )}

        {doneRows.length > 0 && declarantInfoComplete && (
          <>
            <Alert>
              <Shield className="h-4 w-4" />
              <AlertDescription className="space-y-1">
                <p className="font-medium">Supported formats</p>
                <p className="text-xs">
                  Bitcoin Signed Message (legacy format) — supported by Bitcoin Core, Electrum,
                  BlueWallet, Sparrow, Trezor, Ledger, and most hardware/software wallets.
                  Works for P2PKH (1…), P2SH-P2WPKH (3…), and native SegWit P2WPKH (bc1q…) addresses.
                </p>
                <p className="text-xs">
                  BIP-322 — for native SegWit (bc1q…), Taproot (bc1p…), and P2SH-wrapped
                  (3…) addresses, including multisig vaults (P2WSH, P2SH-P2WSH, and Taproot
                  script-path). Paste the base64 signature produced by a BIP-322 capable
                  wallet such as Bitcoin Core 24+ or Sparrow.
                </p>
              </AlertDescription>
            </Alert>

            {verifiedCount > 0 && (
              <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400 font-medium">
                <ShieldCheck className="h-4 w-4" />
                {verifiedCount} of {doneRows.length} address{doneRows.length !== 1 ? "es" : ""} control-verified
              </div>
            )}

            {/* Optional add-ons: verifier reference + block-hash freshness anchor */}
            <div className="rounded-md border">
              <button
                type="button"
                className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium hover-elevate rounded-md"
                onClick={() => setProofAddonsOpen((v) => !v)}
                data-testid="button-proof-addons-toggle"
              >
                <span className="flex items-center gap-2">
                  <Shield className="h-4 w-4 text-muted-foreground" />
                  Optional add-ons
                  <Badge variant="secondary" className="text-xs font-normal">both off by default</Badge>
                </span>
                {proofAddonsOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
              </button>

              {proofAddonsOpen && (
                <div className="border-t px-4 py-4 space-y-5">
                  {/* Verifier reference */}
                  <div className="space-y-2">
                    <Label htmlFor="verifier-reference" className="text-sm font-medium">
                      Verifier reference{" "}
                      <span className="text-muted-foreground font-normal">(optional)</span>
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Free text the requesting party (e.g. a bank) wants embedded in the signed
                      message — such as a case number or request ID. Leave blank to omit.
                    </p>
                    <Input
                      id="verifier-reference"
                      placeholder="e.g. ACME Bank request #2026-001"
                      value={verifierReference}
                      onChange={(e) => setVerifierReference(e.target.value)}
                      data-testid="input-verifier-reference"
                      maxLength={200}
                    />
                    {verifierReference.trim() && (
                      <p className="text-xs text-muted-foreground font-mono">
                        Will appear in message as: <span className="text-foreground">Verifier ref: {verifierReference.trim()}</span>
                      </p>
                    )}
                  </div>

                  <Separator />

                  {/* Block-hash freshness anchor */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-4 flex-wrap">
                      <div className="space-y-0.5">
                        <Label htmlFor="freshness-anchor-toggle" className="text-sm font-medium">
                          Add freshness anchor (block hash){" "}
                          <span className="text-muted-foreground font-normal">(optional)</span>
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          Embeds the current block height + hash in the signed message, proving the
                          signature was made at or after that block. No third party involved.
                        </p>
                      </div>
                      <Switch
                        id="freshness-anchor-toggle"
                        checked={freshnessAnchorEnabled}
                        onCheckedChange={(v) => {
                          setFreshnessAnchorEnabled(v);
                          if (v) {
                            fetchFreshnessAnchor();
                          } else {
                            setFreshnessAnchor(null);
                            setFreshnessAnchorError(null);
                          }
                        }}
                        data-testid="switch-freshness-anchor"
                      />
                    </div>

                    {freshnessAnchorEnabled && (
                      <div className="space-y-3 pl-1">
                        {freshnessAnchor ? (
                          <Alert className="py-2 border-green-500/50 [&>svg]:text-green-600 dark:[&>svg]:text-green-400">
                            <ShieldCheck className="h-3.5 w-3.5" />
                            <AlertDescription className="text-xs space-y-1">
                              <p className="font-medium text-green-700 dark:text-green-300">Block anchor set</p>
                              <p className="font-mono break-all">Height: {freshnessAnchor.height}</p>
                              <p className="font-mono break-all">Hash: {freshnessAnchor.hash}</p>
                              <p className="text-muted-foreground">Fetched: {freshnessAnchor.fetchedAt}</p>
                              <p className="text-muted-foreground">
                                This proves signatures were created at or after block {freshnessAnchor.height}.
                              </p>
                            </AlertDescription>
                          </Alert>
                        ) : null}

                        <div className="flex gap-2 flex-wrap">
                          <Button
                            size="sm"
                            variant={freshnessAnchor ? "outline" : "default"}
                            onClick={fetchFreshnessAnchor}
                            disabled={freshnessAnchorFetching}
                            data-testid="button-fetch-freshness-anchor"
                          >
                            {freshnessAnchorFetching ? (
                              <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Fetching…</>
                            ) : freshnessAnchor ? (
                              <><RefreshCw className="h-3.5 w-3.5 mr-1.5" />Refresh anchor</>
                            ) : (
                              <><Download className="h-3.5 w-3.5 mr-1.5" />Fetch current block</>
                            )}
                          </Button>
                          {freshnessAnchor && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => { setFreshnessAnchor(null); setFreshnessAnchorError(null); }}
                              data-testid="button-clear-freshness-anchor"
                            >
                              <X className="h-3.5 w-3.5 mr-1.5" />Clear
                            </Button>
                          )}
                        </div>

                        {freshnessAnchorError && (
                          <div className="space-y-2">
                            <Alert variant="destructive" className="py-2">
                              <AlertCircle className="h-3.5 w-3.5" />
                              <AlertDescription className="text-xs">
                                {freshnessAnchorError}
                              </AlertDescription>
                            </Alert>
                            <p className="text-xs text-muted-foreground">
                              Paste the block height and hash manually — you can look them up on any
                              Bitcoin block explorer.
                            </p>
                            <div className="flex gap-2 flex-wrap items-start">
                              <div className="space-y-1">
                                <Label className="text-xs">Block height</Label>
                                <Input
                                  placeholder="e.g. 900000"
                                  value={freshnessManualHeight}
                                  onChange={(e) => setFreshnessManualHeight(e.target.value)}
                                  className="w-32 text-xs font-mono"
                                  aria-invalid={!!freshnessManualHeightError}
                                  data-testid="input-freshness-manual-height"
                                />
                                {freshnessManualHeightError && (
                                  <p
                                    className="text-xs text-destructive"
                                    data-testid="error-freshness-manual-height"
                                  >
                                    {freshnessManualHeightError}
                                  </p>
                                )}
                              </div>
                              <div className="space-y-1 flex-1">
                                <Label className="text-xs">Block hash</Label>
                                <Input
                                  placeholder="64-character hex hash"
                                  value={freshnessManualHash}
                                  onChange={(e) => setFreshnessManualHash(e.target.value)}
                                  className="text-xs font-mono"
                                  aria-invalid={!!freshnessManualHashError}
                                  data-testid="input-freshness-manual-hash"
                                />
                                {freshnessManualHashError && (
                                  <p
                                    className="text-xs text-destructive"
                                    data-testid="error-freshness-manual-hash"
                                  >
                                    {freshnessManualHashError}
                                  </p>
                                )}
                              </div>
                              <div className="space-y-1">
                                <Label className="text-xs invisible">Apply</Label>
                                <Button
                                  size="sm"
                                  onClick={applyManualFreshnessAnchor}
                                  disabled={!canApplyManualFreshnessAnchor}
                                  data-testid="button-apply-manual-freshness"
                                >
                                  Apply
                                </Button>
                              </div>
                            </div>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-xs"
                              onClick={() => { setFreshnessAnchorEnabled(false); setFreshnessAnchor(null); setFreshnessAnchorError(null); }}
                              data-testid="button-proceed-without-anchor"
                            >
                              Proceed without freshness anchor
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-6">
              {doneRows.map((row, idx) => {
                const cs = controlStates[row.raw] ?? { paste: "", status: "idle" as ControlStatus };
                const isTaproot = row.raw.startsWith("bc1p") || row.raw.startsWith("tb1p");
                const challengeMsg = buildChallengeMessage({
                  address: row.raw,
                  declarantName,
                  declarationDate,
                  purpose,
                  nonce: declarationNonce,
                  verifierReference: verifierReference || undefined,
                  freshnessAnchor: freshnessAnchor ?? undefined,
                });
                const copied = copiedAddresses.has(row.raw);

                return (
                  <div key={idx} className="space-y-3 rounded-md border p-4">
                    <div className="flex items-start justify-between gap-2 flex-wrap">
                      <div className="font-mono text-xs break-all text-muted-foreground">
                        {row.raw}
                      </div>
                      {cs.status === "verified" && (
                        <Badge className="gap-1 bg-green-600 dark:bg-green-700 text-white shrink-0">
                          <ShieldCheck className="h-3 w-3" />
                          Control Verified
                        </Badge>
                      )}
                      {cs.status === "failed" && (
                        <Badge variant="destructive" className="gap-1 shrink-0">
                          <AlertCircle className="h-3 w-3" />
                          Verification Failed
                        </Badge>
                      )}
                      {cs.status === "idle" && cs.staleAfterVerify && (
                        <Badge
                          variant="outline"
                          className="gap-1 shrink-0 border-amber-500 text-amber-600 dark:text-amber-400"
                          data-testid={`badge-stale-${idx}`}
                        >
                          <AlertCircle className="h-3 w-3" />
                          Re-verification Needed
                        </Badge>
                      )}
                      {cs.status === "idle" && !cs.staleAfterVerify && (
                        <Badge variant="secondary" className="gap-1 shrink-0">
                          <Shield className="h-3 w-3" />
                          Self-Declared (Unverified)
                        </Badge>
                      )}
                    </div>

                    {cs.status === "idle" && cs.staleAfterVerify && (
                      <Alert
                        className="py-2 border-amber-500/60 text-amber-700 dark:text-amber-300 [&>svg]:text-amber-600 dark:[&>svg]:text-amber-400"
                        data-testid={`alert-stale-${idx}`}
                      >
                        <AlertCircle className="h-3.5 w-3.5" />
                        <AlertDescription className="text-xs">
                          Challenge message changed — re-verify your signature. The declarant
                          details, verifier reference, or block anchor were updated, so the
                          previous signature no longer matches.
                        </AlertDescription>
                      </Alert>
                    )}

                    {(
                      <>
                        <div className="space-y-1">
                          <div className="flex items-center justify-between">
                            <Label className="text-xs font-medium">Challenge Message</Label>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleCopyChallenge(row.raw)}
                                  data-testid={`button-copy-challenge-${idx}`}
                                  className="h-7 text-xs gap-1.5"
                                >
                                  {copied ? (
                                    <>
                                      <ClipboardCheck className="h-3.5 w-3.5 text-green-600" />
                                      Copied
                                    </>
                                  ) : (
                                    <>
                                      <Copy className="h-3.5 w-3.5" />
                                      Copy
                                    </>
                                  )}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Copy message to clipboard</TooltipContent>
                            </Tooltip>
                          </div>
                          <pre
                            className="rounded-md bg-muted/60 px-3 py-2 text-xs font-mono whitespace-pre-wrap break-all leading-relaxed"
                            data-testid={`text-challenge-${idx}`}
                          >
                            {challengeMsg}
                          </pre>
                          <p className="text-xs text-muted-foreground">
                            {isTaproot
                              ? 'In a BIP-322 capable wallet (Bitcoin Core 24+, Sparrow), use "Sign Message" and paste the text above exactly as shown.'
                              : 'In your wallet, use "Sign Message" (or equivalent) and paste the text above exactly as shown.'}
                          </p>
                        </div>

                        <div className="space-y-2">
                          <Label className="text-xs font-medium" htmlFor={`sig-input-${idx}`}>
                            {isTaproot
                              ? "Paste BIP-322 Signature (base64)"
                              : "Paste Wallet Signature (base64)"}
                          </Label>
                          <Textarea
                            id={`sig-input-${idx}`}
                            placeholder="Paste the base64 signature from your wallet here…"
                            className="min-h-[80px] font-mono text-xs resize-none"
                            value={cs.paste}
                            onChange={(e) => handleSignaturePaste(row.raw, e.target.value)}
                            data-testid={`textarea-signature-${idx}`}
                            disabled={cs.status === "verifying"}
                          />

                          {cs.status === "failed" && cs.error && (
                            <Alert variant="destructive" className="py-2">
                              <AlertCircle className="h-3.5 w-3.5" />
                              <AlertDescription className="text-xs">
                                {cs.error}
                              </AlertDescription>
                            </Alert>
                          )}

                          {cs.status === "verified" && (
                            <div className="flex items-center gap-2 text-xs text-green-600 dark:text-green-400 font-medium">
                              <ShieldCheck className="h-3.5 w-3.5" />
                              Signature verified
                              {cs.verifiedFormat
                                ? ` (${signatureFormatLabel(cs.verifiedFormat)})`
                                : ""}
                              {" "}— control of this address is cryptographically proven.
                            </div>
                          )}

                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant={cs.status === "verified" ? "outline" : "default"}
                              onClick={() => handleVerify(row.raw)}
                              disabled={cs.status === "verifying" || !cs.paste.trim()}
                              data-testid={`button-verify-${idx}`}
                            >
                              {cs.status === "verifying" ? (
                                <>
                                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                  Verifying…
                                </>
                              ) : cs.status === "verified" ? (
                                <>
                                  <ShieldCheck className="h-3.5 w-3.5 mr-1.5" />
                                  Re-verify
                                </>
                              ) : (
                                <>
                                  <Shield className="h-3.5 w-3.5 mr-1.5" />
                                  Verify Signature
                                </>
                              )}
                            </Button>

                            {(cs.paste || cs.status !== "idle") && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  setControlStates((prev) => ({
                                    ...prev,
                                    [row.raw]: { paste: "", status: "idle" },
                                  }))
                                }
                                data-testid={`button-clear-sig-${idx}`}
                              >
                                <X className="h-3.5 w-3.5 mr-1.5" />
                                Clear
                              </Button>
                            )}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
