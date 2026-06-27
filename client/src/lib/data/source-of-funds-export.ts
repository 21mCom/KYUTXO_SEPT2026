/**
 * Source of Funds report export — offline-first plain-text generation.
 *
 * Mirrors the Fund Trail export's incompleteness-warning pattern: when a busy
 * address has more funding transactions than the per-report cap allows, the
 * report only processes the most recent slice for performance. To stop a shared
 * export from misleading a reader into thinking the funding history is complete,
 * the exported file carries a clear "results are partial" warning with
 * shown/total counts whenever truncation occurred.
 *
 * Everything is produced entirely client-side to preserve KYUTXO's offline-first
 * guarantee — no network requests are made.
 */

import { formatBTC, truncateAddress } from "@/lib/bitcoin";

/** One funding event feeding the selected address. */
export interface FundingSource {
  txid: string;
  date: string;
  blockHeight: number;
  amountSats: number;
  fromAddress: string;
  fromLabel?: string;
  fromOwner?: string;
  isInternalTransfer: boolean;
  priceAtTime?: number;
  costBasisUSD?: number;
}

/**
 * Cap status for a Source of Funds report. When the address had more funding
 * transactions than the per-report cap allows, `capped` is true and the
 * shown/total counts summarize how much of the funding history is missing so an
 * exported artifact can warn the reader it is incomplete.
 */
export interface SourceOfFundsCapInfo {
  capped: boolean;
  /** Funding transactions actually processed and shown. */
  shownTxCount: number;
  /** Funding transactions that touched the address (the full count). */
  totalTxCount: number;
}

export interface SourceOfFundsData {
  address: string;
  label: string;
  owner?: string;
  walletName?: string;
  currentBalanceSats: number;
  totalReceivedSats: number;
  fundingSources: FundingSource[];
  currentPriceUSD?: number;
  currentValueUSD?: number;
  totalCostBasisUSD?: number;
  unrealizedGainUSD?: number;
  internalTransferCount: number;
  externalFundingCount: number;
  /** Cap status describing whether the funding history was truncated. */
  cap: SourceOfFundsCapInfo;
}

/** A funding transaction paired with the block height it confirmed at. */
export interface DatedFundingTxid {
  txid: string;
  blockHeight: number;
}

/**
 * Choose which funding transactions to retain when a busy address has more
 * funding history than the per-report cap allows.
 *
 * For a Source of Funds declaration the OLDEST funding is usually the most
 * important (original provenance / cost basis), while the most recent funding
 * describes the address's current state. Rather than keeping whatever order the
 * database index happened to return, we sort deterministically by block height
 * (oldest first, tie-broken by txid) and retain a documented split: the oldest
 * half of the cap plus the newest half. This guarantees the original provenance
 * is never silently dropped while still capturing recent activity.
 *
 * Returns the kept txids in oldest-first order. When the input already fits
 * inside the cap, every txid is returned (still sorted oldest-first).
 */
export function selectFundingTxidsUnderCap(
  entries: DatedFundingTxid[],
  limit: number,
): string[] {
  const sorted = [...entries].sort((a, b) =>
    a.blockHeight !== b.blockHeight
      ? a.blockHeight - b.blockHeight
      : a.txid < b.txid
        ? -1
        : a.txid > b.txid
          ? 1
          : 0,
  );

  if (limit <= 0) return [];
  if (sorted.length <= limit) return sorted.map((e) => e.txid);

  const oldestCount = Math.ceil(limit / 2);
  const newestCount = limit - oldestCount;
  const oldest = sorted.slice(0, oldestCount);
  const newest = newestCount > 0 ? sorted.slice(sorted.length - newestCount) : [];
  return [...oldest, ...newest].map((e) => e.txid);
}

/**
 * Human-readable warning line describing how much of the funding history is
 * missing. Returns null when nothing was capped, so an uncapped export stays
 * free of any incompleteness notice.
 */
export function sourceOfFundsCapWarning(cap: SourceOfFundsCapInfo): string | null {
  if (!cap.capped) return null;
  const shown = cap.shownTxCount.toLocaleString();
  const total = cap.totalTxCount.toLocaleString();
  return (
    `WARNING: This Source of Funds report is incomplete. Because this address ` +
    `has a large number of funding transactions, only ${shown} of ${total} were ` +
    `included for performance. The funding sources below do not represent the ` +
    `complete funding history.`
  );
}

/**
 * Build the plain-text Source of Funds declaration. When the report's funding
 * history was truncated, a prominent warning is prepended above the body (and
 * also noted in the summary) so a reader can never mistake a partial export for
 * a complete one. Fully offline — no external resources.
 */
export function buildSourceOfFundsText(
  data: SourceOfFundsData,
  currency: string,
  generatedAt: string = new Date().toISOString(),
): string {
  const warning = sourceOfFundsCapWarning(data.cap);

  const lines: string[] = [
    "SOURCE OF FUNDS DECLARATION",
    "=".repeat(50),
    "",
  ];

  if (warning) {
    lines.push(warning, "");
  }

  lines.push(
    `Address: ${data.address}`,
    `Label: ${data.label}`,
    data.owner ? `Owner: ${data.owner}` : "",
    data.walletName ? `Wallet: ${data.walletName}` : "",
    "",
    "SUMMARY",
    "-".repeat(30),
    `Current Balance: ${formatBTC(data.currentBalanceSats)} BTC`,
    `Total Received: ${formatBTC(data.totalReceivedSats)} BTC`,
    data.currentValueUSD
      ? `Current Value: $${data.currentValueUSD.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`
      : "",
    data.totalCostBasisUSD
      ? `Cost Basis (External): $${data.totalCostBasisUSD.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`
      : "",
    data.unrealizedGainUSD !== undefined
      ? `Unrealized Gain/Loss: $${data.unrealizedGainUSD.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`
      : "",
    "",
    `Internal Transfers: ${data.internalTransferCount}`,
    `External Funding Events: ${data.externalFundingCount}`,
  );

  if (data.cap.capped) {
    lines.push(
      `Funding Transactions Shown: ${data.cap.shownTxCount.toLocaleString()} of ${data.cap.totalTxCount.toLocaleString()} (truncated)`,
    );
  }

  lines.push("", "FUNDING SOURCES", "-".repeat(30), "");

  for (const source of data.fundingSources) {
    lines.push(`Date: ${source.date}`);
    lines.push(`Transaction: ${source.txid}`);
    lines.push(`Amount: ${formatBTC(source.amountSats)} BTC`);
    lines.push(`From: ${source.fromLabel || truncateAddress(source.fromAddress, 15, 15)}`);
    if (source.fromOwner) lines.push(`From Owner: ${source.fromOwner}`);
    lines.push(`Type: ${source.isInternalTransfer ? "INTERNAL TRANSFER (Non-taxable)" : "EXTERNAL FUNDING"}`);
    if (source.priceAtTime) lines.push(`Price at Time: $${source.priceAtTime.toLocaleString()} ${currency}`);
    if (source.costBasisUSD) lines.push(`Cost Basis: $${source.costBasisUSD.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`);
    lines.push("");
  }

  lines.push("");
  lines.push(`Generated: ${generatedAt}`);

  return lines.filter((l) => l !== "").join("\n");
}

/** Build the dated download filename for a source-of-funds export. */
export function sourceOfFundsFilename(
  address: string,
  date: Date = new Date(),
): string {
  return `source-of-funds-${address.substring(0, 10)}-${date.toISOString().split("T")[0]}.txt`;
}
