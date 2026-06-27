/**
 * Fund Trail export — offline-first CSV and PDF generation.
 *
 * Captures the currently-displayed Fund Trail snapshot (the center node, its
 * source/destination groups, and any hops the user expanded) and renders it as
 * either a CSV (one row per address flow) or a formatted single-page PDF summary
 * that mirrors the on-screen layout.
 *
 * Everything is produced entirely client-side — jspdf/autotable are bundled and
 * no network requests are made — to preserve KYUTXO's offline-first guarantee.
 */

import {
  type GroupingDimension,
  type GroupFlow,
  type GroupFlowDetail,
  type TrailHop,
  deduplicateDetails,
  formatBtc,
} from "./fund-trail-engine";

// ---------------------------------------------------------------------------
// Snapshot model
// ---------------------------------------------------------------------------

/** One group flow in the export tree, with its expanded children (next hop). */
export interface ExportFlowNode {
  groupLabel: string;
  totalSats: number;
  isUnknown: boolean;
  details: GroupFlowDetail[];
  /** Expanded next-hop flows in the same direction (empty when not expanded). */
  children: ExportFlowNode[];
}

/** The full, serializable snapshot of what is currently on screen. */
export interface FundTrailSnapshot {
  centerLabel: string;
  dimension: GroupingDimension;
  generatedAt: string;
  sources: ExportFlowNode[];
  destinations: ExportFlowNode[];
}

const DIMENSION_LABELS: Record<GroupingDimension, string> = {
  walletName: "Wallet",
  owner: "Owner",
  seedName: "Seed",
};

/**
 * Stable path key for a flow, matching the keys the FlowCard tree registers its
 * expanded hops under. The root direction prefix lets the snapshot builder pick
 * the correct side (sources vs destinations) of each expanded hop.
 */
export function flowPath(
  parentPath: string,
  direction: "source" | "dest",
  groupLabel: string,
): string {
  return parentPath ? `${parentPath}/${groupLabel}` : `${direction}/${groupLabel}`;
}

/**
 * Recursively assemble an ExportFlowNode for a flow, pulling its expanded next
 * hop (if any) from the registry of hops keyed by path. `direction` selects
 * which side of the expanded hop to recurse into.
 */
function buildNode(
  flow: GroupFlow,
  path: string,
  direction: "source" | "dest",
  registry: Map<string, TrailHop>,
): ExportFlowNode {
  const hop = registry.get(path);
  const childFlows = hop
    ? direction === "source"
      ? hop.sources
      : hop.destinations
    : [];
  const children = childFlows.map((cf) =>
    buildNode(cf, flowPath(path, direction, cf.groupLabel), direction, registry),
  );
  return {
    groupLabel: flow.groupLabel,
    totalSats: flow.totalSats,
    isUnknown: flow.isUnknown,
    details: deduplicateDetails(flow.details),
    children,
  };
}

/**
 * Build the export snapshot from the center hop plus the registry of expanded
 * hops the FlowCard tree has reported. This is the single source of truth for
 * the snapshot shape, shared by the CSV and PDF builders (and their tests).
 */
export function buildFundTrailSnapshot(
  centerLabel: string,
  dimension: GroupingDimension,
  centerHop: TrailHop,
  expandedHops: Map<string, TrailHop>,
  generatedAt: string = new Date().toISOString(),
): FundTrailSnapshot {
  return {
    centerLabel,
    dimension,
    generatedAt,
    sources: centerHop.sources.map((f) =>
      buildNode(f, flowPath("", "source", f.groupLabel), "source", expandedHops),
    ),
    destinations: centerHop.destinations.map((f) =>
      buildNode(f, flowPath("", "dest", f.groupLabel), "dest", expandedHops),
    ),
  };
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

/**
 * Escape a single CSV cell per RFC 4180: wrap in double quotes when the value
 * contains a comma, quote, or newline, doubling any embedded quotes.
 */
function csvCell(value: string | number): string {
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Format satoshis as a plain decimal BTC string (no unit) for spreadsheets. */
function btcAmount(sats: number): string {
  return (sats / 1e8).toFixed(8);
}

/** Format a Unix block time as an ISO date (YYYY-MM-DD), or "" when unknown. */
function isoDate(blockTime: number): string {
  if (!blockTime) return "";
  return new Date(blockTime * 1000).toISOString().slice(0, 10);
}

/** Append one flattened CSV row per detail for a node and its children. */
function collectCsvRows(
  node: ExportFlowNode,
  direction: "source" | "destination",
  rows: string[][],
): void {
  for (const d of node.details) {
    rows.push([
      direction,
      node.groupLabel,
      btcAmount(d.amount),
      d.address,
      d.txid,
      isoDate(d.blockTime),
    ]);
  }
  for (const child of node.children) {
    collectCsvRows(child, direction, rows);
  }
}

/**
 * Build a CSV export of the Fund Trail snapshot. Columns: direction, group,
 * amount_btc, address, txid, date. One row per address flow, covering the
 * center node's sources and destinations plus every expanded hop. Fully
 * offline — no external resources.
 */
export function buildFundTrailCsv(snapshot: FundTrailSnapshot): string {
  const headers = ["direction", "group", "amount_btc", "address", "txid", "date"];
  const rows: string[][] = [];
  for (const node of snapshot.sources) {
    collectCsvRows(node, "source", rows);
  }
  for (const node of snapshot.destinations) {
    collectCsvRows(node, "destination", rows);
  }
  const lines = [headers, ...rows].map((cols) => cols.map(csvCell).join(","));
  return lines.join("\r\n");
}

// ---------------------------------------------------------------------------
// PDF export
// ---------------------------------------------------------------------------

/** Flatten a node tree into [indentDepth, node] pairs (depth-first, in order). */
export function flattenNodes(
  nodes: ExportFlowNode[],
  depth: number,
  out: { depth: number; node: ExportFlowNode }[],
): void {
  for (const node of nodes) {
    out.push({ depth, node });
    flattenNodes(node.children, depth + 1, out);
  }
}

/** Sum the top-level totals for a side (center hop in/out). */
export function sumTopLevel(nodes: ExportFlowNode[]): number {
  return nodes.reduce((s, n) => s + n.totalSats, 0);
}

/** Options controlling what the Fund Trail PDF includes. */
export interface FundTrailPdfOptions {
  /**
   * When true, embed the per-group deduplicated detail rows (address, txid,
   * amount, date) beneath the summary, so the PDF carries the same information
   * the CSV does. Output paginates across pages as needed.
   */
  detailed?: boolean;
}

/**
 * Build an offline PDF summary of the Fund Trail snapshot that mirrors the
 * on-screen layout: a center-node header with total in/out, then a Sources
 * section and a Destinations section listing each group (indented by hop depth)
 * with its amount and address count.
 *
 * When `options.detailed` is set, each group additionally lists its
 * deduplicated detail rows (address, txid, amount, date) — the same data the
 * CSV contains — so the document is self-contained for hand-off. Long output
 * paginates gracefully across multiple pages rather than overflowing one page.
 *
 * Fully offline — jspdf/autotable are bundled, so no external resources are
 * fetched.
 */
export async function buildFundTrailPdf(
  snapshot: FundTrailSnapshot,
  options: FundTrailPdfOptions = {},
): Promise<Blob> {
  const detailed = options.detailed ?? false;
  const jsPDFModule = await import("jspdf");
  const autoTableModule = await import("jspdf-autotable");
  const jsPDF = jsPDFModule.default;
  const autoTable = autoTableModule.default;

  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  doc.setFontSize(18);
  doc.text(detailed ? "Fund Trail (detailed)" : "Fund Trail", 14, 20);

  const totalIn = sumTopLevel(snapshot.sources);
  const totalOut = sumTopLevel(snapshot.destinations);

  doc.setFontSize(10);
  doc.setTextColor(90);
  doc.text(
    `${DIMENSION_LABELS[snapshot.dimension]}: ${snapshot.centerLabel}`,
    14,
    27,
  );
  doc.text(
    `${formatBtc(totalIn)} in  |  ${formatBtc(totalOut)} out`,
    14,
    33,
  );
  doc.setTextColor(0);

  let cursorY = 40;

  const getFinalY = (): number => {
    const lastTable = (doc as unknown as { lastAutoTable?: { finalY: number } })
      .lastAutoTable;
    return lastTable?.finalY ?? cursorY;
  };

  /** Start a fresh page when there isn't room for at least `needed` mm. */
  const ensureSpace = (needed: number) => {
    if (cursorY + needed > pageHeight - 14) {
      doc.addPage();
      cursorY = 20;
    }
  };

  const renderSection = (
    title: string,
    nodes: ExportFlowNode[],
    emptyText: string,
  ) => {
    ensureSpace(20);
    doc.setFontSize(12);
    doc.setTextColor(0);
    doc.text(title, 14, cursorY);
    cursorY += 3;

    if (nodes.length === 0) {
      doc.setFontSize(9);
      doc.setTextColor(120);
      doc.text(emptyText, 14, cursorY + 4);
      doc.setTextColor(0);
      cursorY += 12;
      return;
    }

    const flat: { depth: number; node: ExportFlowNode }[] = [];
    flattenNodes(nodes, 0, flat);
    const body = flat.map(({ depth, node }) => [
      `${"    ".repeat(depth)}${depth > 0 ? "↳ " : ""}${node.groupLabel}`,
      formatBtc(node.totalSats),
      String(node.details.length),
    ]);

    autoTable(doc, {
      startY: cursorY,
      head: [["Group", "Amount", "Addresses"]],
      body,
      styles: { fontSize: 8, cellPadding: 1.5 },
      headStyles: { fillColor: [41, 128, 185] },
      columnStyles: {
        1: { halign: "right" },
        2: { halign: "right" },
      },
    });
    cursorY = getFinalY() + 8;

    if (detailed) {
      for (const { depth, node } of flat) {
        renderNodeDetails(depth, node);
      }
    }
  };

  /** Render one group's deduplicated detail rows as a labeled sub-table. */
  const renderNodeDetails = (depth: number, node: ExportFlowNode) => {
    if (node.details.length === 0) return;

    ensureSpace(16);
    doc.setFontSize(9);
    doc.setTextColor(60);
    const prefix = depth > 0 ? "↳ " : "";
    doc.text(
      `${prefix}${node.groupLabel} — ${formatBtc(node.totalSats)}`,
      16,
      cursorY,
    );
    doc.setTextColor(0);
    cursorY += 2;

    const detailBody = node.details.map((d) => [
      d.address,
      d.txid,
      btcAmount(d.amount),
      isoDate(d.blockTime),
    ]);

    autoTable(doc, {
      startY: cursorY,
      margin: { left: 16 },
      head: [["Address", "Txid", "Amount (BTC)", "Date"]],
      body: detailBody,
      styles: { fontSize: 7, cellPadding: 1, overflow: "linebreak" },
      headStyles: { fillColor: [120, 120, 120] },
      columnStyles: {
        0: { cellWidth: 55 },
        1: { cellWidth: 75 },
        2: { halign: "right" },
        3: { halign: "right" },
      },
    });
    cursorY = getFinalY() + 6;
  };

  renderSection("Sources (incoming)", snapshot.sources, "No incoming transactions found.");
  renderSection("Destinations (outgoing)", snapshot.destinations, "No outgoing transactions found.");

  // Footer on every page (page count is known only after all content is laid out).
  const pageCount = doc.getNumberOfPages();
  const generated = new Date().toLocaleString();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(`Generated: ${generated}`, 14, pageHeight - 10);
    doc.text(
      `KYUTXO — generated offline  ·  Page ${p} of ${pageCount}`,
      pageWidth - 14,
      pageHeight - 10,
      { align: "right" },
    );
  }
  doc.setTextColor(0);

  return doc.output("blob");
}

// ---------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------

/** Build the dated download filename for a fund-trail export. */
export function fundTrailFilename(
  centerLabel: string,
  ext: "csv" | "pdf",
  date: Date = new Date(),
): string {
  const safeLabel = centerLabel
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "fund-trail";
  return `fund-trail-${safeLabel}-${date.toISOString().slice(0, 10)}.${ext}`;
}

/** Trigger a browser download of a blob via a temporary anchor. */
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
