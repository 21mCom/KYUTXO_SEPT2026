import { csvEscape, csvField } from "./csv-export";
import { sanitizePdfText } from "./pdfText";
import type {
  CoinOriginHolding,
  CoinOriginHop,
  CoinOriginOutpoint,
  CoinOriginsLedger,
  CoinOriginsSummary,
} from "./coin-origins-core";

export interface CoinOriginsExportPayload {
  title: string;
  scopeLabel: string;
  holdings: CoinOriginHolding[];
  outpoints: CoinOriginOutpoint[];
  hops: CoinOriginHop[];
  summary: CoinOriginsSummary;
}

/**
 * Canonical payload shared by the rendered ledger and both exports. Selecting
 * an outpoint yields a Coin Passport; omitting it yields Holdings by Origin.
 */
export function buildCoinOriginsExportPayload(
  ledger: CoinOriginsLedger,
  options: { walletName?: string; outpoint?: string } = {},
): CoinOriginsExportPayload {
  const selected = options.outpoint
    ? ledger.outpoints.filter((row) => `${row.txid}:${row.vout}` === options.outpoint)
    : ledger.outpoints;
  const lotIds = new Set(selected.flatMap((row) => row.allocations.map((a) => a.lotId)));
  const holdings = options.outpoint
    ? ledger.holdings
      .filter((row) => lotIds.has(row.lotId))
      .map((row) => ({
        ...row,
        sats: selected.reduce(
          (sum, output) => sum + (output.allocations.find((a) => a.lotId === row.lotId)?.sats ?? 0),
          0,
        ),
        outpointCount: selected.length,
      }))
    : ledger.holdings;
  const txids = new Set(selected.flatMap((row) => row.hopTxids));
  const hops = options.outpoint
    ? ledger.hops.filter((hop) => txids.has(hop.txid) || holdings.some((h) => h.acquiredTxid === hop.txid))
    : ledger.hops;
  const currentSats = selected.reduce((sum, row) => sum + row.amountSats, 0);
  const lotBoundaries = new Map(ledger.lots.map((lot) => [lot.lotId, lot.sourceBoundary]));
  const unknownSats = selected.reduce(
    (sum, row) => sum + row.allocations.reduce(
      (allocationSum, allocation) =>
        allocationSum + (
          allocation.lotId === "unknown" ||
          (lotBoundaries.get(allocation.lotId) ?? "unknown") !== "deterministic"
            ? allocation.sats
            : 0
        ),
      0,
    ),
    0,
  );
  return {
    title: options.outpoint ? "Coin Passport" : "Holdings by Origin",
    scopeLabel: options.outpoint ?? options.walletName ?? "Entire vault",
    holdings,
    outpoints: selected,
    hops,
    summary: {
      ...ledger.summary,
      currentSats,
      allocatedSats: currentSats,
      knownSats: currentSats - unknownSats,
      unknownSats,
      reconciled:
        hops.every((hop) => hop.reconciled) &&
        selected.every((row) => row.amountSats === row.allocations.reduce((sum, a) => sum + a.sats, 0)),
    },
  };
}

export function buildCoinOriginsCsv(payload: CoinOriginsExportPayload): string {
  const rows: string[][] = [[
    "scope",
    "outpoint",
    "address",
    "boundary",
    "lot_id",
    "origin_txid",
    "origin_vout",
    "acquired_at",
    "satoshis",
  ]];
  const holdingById = new Map(payload.holdings.map((row) => [row.lotId, row]));
  for (const output of payload.outpoints) {
    for (const allocation of output.allocations) {
      const holding = holdingById.get(allocation.lotId);
      rows.push([
        payload.scopeLabel,
        `${output.txid}:${output.vout}`,
        output.address,
        output.boundary,
        allocation.lotId,
        holding?.acquiredTxid ?? "",
        holding?.acquiredVout == null ? "" : String(holding.acquiredVout),
        holding?.acquiredAt ? new Date(holding.acquiredAt * 1000).toISOString() : "",
        String(allocation.sats),
      ]);
    }
  }
  return rows.map((row, index) =>
    row.map((value) => index === 0 ? csvEscape(value) : csvField(value)).join(","),
  ).join("\r\n");
}

export async function buildCoinOriginsPdf(payload: CoinOriginsExportPayload): Promise<Blob> {
  const [{ jsPDF }, autoTableModule] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ]);
  const autoTable = autoTableModule.default;
  const doc = new jsPDF();
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(sanitizePdfText(payload.title), 14, 18);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(sanitizePdfText(`Scope: ${payload.scopeLabel}`), 14, 25);
  doc.text(
    sanitizePdfText(
      `${payload.summary.currentSats.toLocaleString()} sats held; ` +
      `${payload.summary.unknownSats.toLocaleString()} sats unknown; ` +
      `reconciled: ${payload.summary.reconciled ? "yes" : "no"}`,
    ),
    14,
    31,
  );
  autoTable(doc, {
    startY: 36,
    head: [["Origin", "Boundary", "Satoshis", "Outpoints"]],
    body: payload.holdings.map((row) => [
      sanitizePdfText(row.label),
      row.boundary,
      row.sats.toLocaleString(),
      row.outpointCount.toLocaleString(),
    ]),
    styles: { font: "helvetica", fontSize: 8 },
  });
  const afterHoldings = ((doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? 36) + 8;
  autoTable(doc, {
    startY: afterHoldings,
    head: [["Outpoint", "Address", "Boundary", "Satoshis"]],
    body: payload.outpoints.map((row) => [
      `${row.txid}:${row.vout}`,
      sanitizePdfText(row.address),
      row.boundary,
      row.amountSats.toLocaleString(),
    ]),
    styles: { font: "helvetica", fontSize: 7 },
    columnStyles: { 0: { cellWidth: 68 }, 1: { cellWidth: 68 } },
  });
  const afterOutpoints = ((doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? afterHoldings) + 8;
  autoTable(doc, {
    startY: afterOutpoints,
    head: [["Outpoint", "Origin lot", "Boundary", "Satoshis"]],
    body: payload.outpoints.flatMap((row) => row.allocations.map((allocation) => [
      `${row.txid}:${row.vout}`,
      sanitizePdfText(allocation.lotId),
      allocation.lotId === "unknown" ? "unknown" : row.boundary,
      allocation.sats.toLocaleString(),
    ])),
    styles: { font: "helvetica", fontSize: 7 },
  });
  const afterAllocations = ((doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? afterOutpoints) + 8;
  autoTable(doc, {
    startY: afterAllocations,
    head: [["Transaction", "Event", "Boundary", "Fee", "Exact"]],
    body: payload.hops.map((hop) => [
      hop.txid,
      hop.kind,
      hop.boundary,
      hop.feeSats.toLocaleString(),
      hop.reconciled ? "yes" : `no (${hop.residualSats})`,
    ]),
    styles: { font: "helvetica", fontSize: 7 },
    columnStyles: { 0: { cellWidth: 72 } },
  });
  return doc.output("blob");
}