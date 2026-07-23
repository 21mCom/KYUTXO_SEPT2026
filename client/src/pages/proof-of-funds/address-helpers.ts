import { validateAddress } from "@/lib/bitcoin";
import type { SignatureFormat } from "@/lib/signatureVerify";

export type BalanceSource = "live" | "offline";
export type RowStatus = "pending" | "loading" | "done" | "empty" | "error";
export type ControlStatus = "idle" | "verifying" | "verified" | "failed";

export interface AddressRow {
  raw: string;
  isInvalid: boolean;
  invalidReason?: string;
  status: RowStatus;
  balanceSats?: number;
  error?: string;
  lastSyncTime?: number;
}

export interface ControlState {
  paste: string;
  status: ControlStatus;
  error?: string;
  verifiedSig?: string;
  staleAfterVerify?: boolean;
  verifiedFormat?: SignatureFormat;
}

export interface BalanceSummary {
  totalSats: number;
  source: BalanceSource;
  asOfLabel: string;
  blockHeight?: number;
  timestamp?: number;
}

export function parseAddressInput(text: string): { rows: AddressRow[]; dupes: number } {
  const lines = text
    .split(/[\n,;]+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const seen = new Set<string>();
  const rows: AddressRow[] = [];
  let dupes = 0;

  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) {
      dupes++;
      continue;
    }
    seen.add(key);

    const result = validateAddress(line);
    if (!result.isValid) {
      rows.push({
        raw: line,
        isInvalid: true,
        invalidReason: result.error || "Not a valid Bitcoin address",
        status: "pending",
      });
    } else {
      rows.push({ raw: line, isInvalid: false, status: "pending" });
    }
  }

  return { rows, dupes };
}

export function formatUnix(unix: number): string {
  return new Date(unix * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function todayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
