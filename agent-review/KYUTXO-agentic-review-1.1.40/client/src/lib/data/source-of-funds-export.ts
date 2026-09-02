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
  fromRecordId?: number;
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
  /**
   * Count of funding sources whose amount could not be resolved (stayed 0)
   * because the funding transaction was never synced. When > 0, received totals
   * may be understated and a non-blocking notice is surfaced to the user,
   * mirroring the Annual Activity Report's unresolved-input warning.
   */
  unresolvedAmountCount: number;
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
  // Mirror the deterministic retention strategy in selectFundingTxidsUnderCap:
  // ceil(limit/2) oldest + the remaining newest. Describe which slice was kept so
  // a reader knows the original provenance and most recent activity are present
  // and only the middle of the history was omitted. When the cap is so small that
  // the newest half rounds to zero, only the oldest funding is retained, so the
  // wording must not promise recent activity that was not included.
  const keptNewest = cap.shownTxCount - Math.ceil(cap.shownTxCount / 2) > 0;
  const strategy = keptNewest
    ? `the oldest and newest funding events were retained, and ` +
      `intermediate funding was omitted for performance`
    : `the oldest funding events were retained, and later funding was ` +
      `omitted for performance`;
  return (
    `WARNING: This Source of Funds report is incomplete. Because this address ` +
    `has a large number of funding transactions, only ${shown} of ${total} were ` +
    `included for performance. To preserve the most relevant provenance, ` +
    `${strategy}. The funding sources below do not represent the complete ` +
    `funding history.`
  );
}

/**
 * Human-readable warning describing that some funding amounts could not be
 * resolved because their funding transaction was never synced, so received
 * totals may be understated. Returns null when every amount resolved, keeping
 * a complete export free of any incompleteness notice. Mirrors the tone of
 * sourceOfFundsCapWarning so both incompleteness notices read consistently.
 */
export function sourceOfFundsUnresolvedWarning(
  unresolvedAmountCount: number,
): string | null {
  if (unresolvedAmountCount <= 0) return null;
  const count = unresolvedAmountCount.toLocaleString();
  const noun = unresolvedAmountCount === 1 ? "funding amount" : "funding amounts";
  return (
    `WARNING: This Source of Funds report may understate the total received. ` +
    `${count} ${noun} could not be resolved because the funding transaction ` +
    `was never synced, so the received totals and the per-source amounts below ` +
    `may be incomplete.`
  );
}

/**
 * Build the plain-text Source of Funds declaration. When the report's funding
 * history was truncated, or some funding amounts could not be resolved, a
 * prominent warning is prepended above the body (and also noted in the summary)
 * so a reader can never mistake a partial export for a complete one. Fully
 * offline — no external resources.
 *
 * When `sample` is true the export is stamped SAMPLE / SPECIMEN: the title gains
 * a specimen suffix, a banner is inserted at the top of every "page" (the body
 * has no real pages, so the banner is repeated at the head of each section) and
 * a closing specimen line is appended, so a reader can never mistake a layout
 * preview built from fictitious data for a real declaration.
 */
export function buildSourceOfFundsText(
  data: SourceOfFundsData,
  currency: string,
  generatedAt: string = new Date().toISOString(),
  sample: boolean = false,
): string {
  const warning = sourceOfFundsCapWarning(data.cap);
  const unresolvedWarning = sourceOfFundsUnresolvedWarning(
    data.unresolvedAmountCount,
  );

  const specimenBanner =
    "*** SAMPLE / SPECIMEN — NOT A VALID DECLARATION ***";

  const lines: string[] = [
    sample
      ? "SOURCE OF FUNDS DECLARATION — SAMPLE / SPECIMEN"
      : "SOURCE OF FUNDS DECLARATION",
    "=".repeat(50),
    "",
  ];

  if (sample) {
    lines.push(
      specimenBanner,
      "This document is a layout preview only. All data below is fictitious " +
        "and was not sourced from the blockchain.",
      "",
    );
  }

  if (warning) {
    lines.push(warning, "");
  }

  if (unresolvedWarning) {
    lines.push(unresolvedWarning, "");
  }

  lines.push(
    `Address: ${data.address}`,
    `Label: ${data.label}`,
    data.owner ? `Owner: ${data.owner}` : "",
    data.walletName ? `Wallet: ${data.walletName}` : "",
    "",
    ...(sample ? [specimenBanner, ""] : []),
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

  if (data.unresolvedAmountCount > 0) {
    lines.push(
      `Unresolved Amounts: ${data.unresolvedAmountCount.toLocaleString()} (received totals may be understated)`,
    );
  }

  lines.push("");
  if (sample) lines.push(specimenBanner, "");
  lines.push("FUNDING SOURCES", "-".repeat(30), "");

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
  lines.push(`Generated${sample ? " (SPECIMEN)" : ""}: ${generatedAt}`);
  if (sample) {
    lines.push(
      "",
      "END OF SAMPLE / SPECIMEN — All data above is fictitious. This is a " +
        "layout preview only and is not a valid Source of Funds declaration.",
    );
  }

  return lines.filter((l) => l !== "").join("\n");
}

/** Build the dated download filename for a source-of-funds export. */
export function sourceOfFundsFilename(
  address: string,
  date: Date = new Date(),
): string {
  return `source-of-funds-${address.substring(0, 10)}-${date.toISOString().split("T")[0]}.txt`;
}

/** Build the dated download filename for a SAMPLE source-of-funds export. */
export function sourceOfFundsSampleFilename(date: Date = new Date()): string {
  return `source-of-funds-SAMPLE-specimen-${date.toISOString().split("T")[0]}.txt`;
}

/**
 * Fictitious Source of Funds data used to render the SAMPLE / SPECIMEN preview.
 *
 * It deliberately exercises every layout branch the real report can show — an
 * external funding event with a cost basis, an internal (non-taxable) transfer,
 * a populated owner/wallet, and a realized cost basis + unrealized gain — so a
 * user previewing the layout sees the full shape of a populated report before
 * entering real data. No warnings or caps are set so the clean, complete layout
 * is shown. All values are invented and never touch the blockchain.
 */
export function buildSampleSourceOfFundsData(): SourceOfFundsData {
  const fundingSources: FundingSource[] = [
    {
      txid:
        "5a1f0e2b9c8d7a6b5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d",
      date: "2023-02-14",
      blockHeight: 778_500,
      amountSats: 150_000_000,
      fromAddress: "bc1qsamplexchangeaddr00000000000000000specimen",
      fromLabel: "Sample Exchange Withdrawal",
      fromOwner: "Acme Exchange (sample)",
      isInternalTransfer: false,
      priceAtTime: 24_500,
      costBasisUSD: 36_750,
    },
    {
      txid:
        "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0",
      date: "2024-08-09",
      blockHeight: 856_200,
      amountSats: 50_000_000,
      fromAddress: "bc1qsampleownwalletaddr0000000000000specimen",
      fromLabel: "Sample Cold Storage",
      fromOwner: "Jane Q. Sample",
      isInternalTransfer: true,
    },
  ];

  return {
    address: "bc1qsampletargetaddr000000000000000000specimen",
    label: "Sample Long-Term Savings",
    owner: "Jane Q. Sample",
    walletName: "Sample Hardware Wallet",
    currentBalanceSats: 200_000_000,
    totalReceivedSats: 200_000_000,
    fundingSources,
    currentPriceUSD: 65_000,
    currentValueUSD: 130_000,
    totalCostBasisUSD: 36_750,
    unrealizedGainUSD: 93_250,
    internalTransferCount: 1,
    externalFundingCount: 1,
    cap: { capped: false, shownTxCount: 2, totalTxCount: 2 },
    unresolvedAmountCount: 0,
  };
}
