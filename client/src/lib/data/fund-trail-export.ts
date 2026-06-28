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
  type HopNode,
  type MultiHopTrailResult,
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
  /**
   * Hop depth at which this node was found (1 = direct counterparty, 2 = one
   * unknown intermediary, …). Present on multi-hop snapshots; absent on
   * single-hop (manually-expanded) snapshots so the existing CSV format is
   * preserved for those.
   */
  hopDepth?: number;
  /**
   * Ordered chain of unknown intermediary addresses traversed between the
   * center and this node (multi-hop snapshots only). Lets the export show
   * *through which* addresses the entity was reached. Empty/undefined for
   * direct hop-1 counterparties and single-hop snapshots.
   */
  pathAddresses?: string[];
}

/**
 * Aggregate cap status across every hop rendered in a snapshot. When the trail
 * was truncated for performance (any hop with isCapped=true), `capped` is true
 * and the shown/total counts summarize how much of the flow is missing so an
 * exported artifact can warn the reader it is incomplete.
 */
export interface FundTrailCapInfo {
  capped: boolean;
  /** Transactions actually rendered across all capped hops. */
  shownTxCount: number;
  /** Transactions that touched those hops' addresses (the full count). */
  totalTxCount: number;
  /** How many distinct hops were capped. */
  cappedHopCount: number;
}

/** The full, serializable snapshot of what is currently on screen. */
export interface FundTrailSnapshot {
  centerLabel: string;
  dimension: GroupingDimension;
  generatedAt: string;
  sources: ExportFlowNode[];
  destinations: ExportFlowNode[];
  /** Cap status aggregated across the center hop and every expanded hop. */
  cap: FundTrailCapInfo;
}

const DIMENSION_LABELS: Record<GroupingDimension, string> = {
  walletName: "Wallet",
  owner: "Owner",
  seedName: "Seed",
};

/**
 * Maximum number of intermediary addresses shown inline in an exported chain
 * before the remainder is summarized. On busy wallets the engine aggregates
 * *all* unknown addresses at each hop into a single bucket, so a chain can hold
 * hundreds of addresses — far too many for a scannable CSV cell or PDF "via:"
 * line. We keep the leading addresses (the ones nearest the center, most useful
 * for reconstructing the path) and replace the tail with a "(+N more)" summary.
 */
export const MAX_INTERMEDIARY_ADDRESSES = 10;

/**
 * Render an intermediary-address chain for export, capping very long chains.
 * Addresses are joined with " > "; when the chain exceeds `maxShown`, only the
 * first `maxShown` are listed followed by "(+N more)" so the total length stays
 * scannable while still reporting how many addresses were elided. Shared by the
 * CSV and PDF builders so both formats summarize identically.
 */
export function summarizeIntermediaryChain(
  addresses: string[],
  maxShown: number = MAX_INTERMEDIARY_ADDRESSES,
): string {
  if (addresses.length <= maxShown) {
    return addresses.join(" > ");
  }
  const shown = addresses.slice(0, maxShown).join(" > ");
  const remaining = addresses.length - maxShown;
  return `${shown} (+${remaining} more)`;
}

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
  reachedHops: TrailHop[],
): ExportFlowNode {
  const hop = registry.get(path);
  if (hop) reachedHops.push(hop);
  const childFlows = hop
    ? direction === "source"
      ? hop.sources
      : hop.destinations
    : [];
  const children = childFlows.map((cf) =>
    buildNode(
      cf,
      flowPath(path, direction, cf.groupLabel),
      direction,
      registry,
      reachedHops,
    ),
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
 * Build a flat export snapshot from a multi-hop trail result.
 * Each HopNode becomes a top-level ExportFlowNode (no nesting — multi-hop
 * results are already fully traversed and presented in a flat list).
 */
export function buildMultiHopFundTrailSnapshot(
  centerLabel: string,
  dimension: GroupingDimension,
  result: MultiHopTrailResult,
  generatedAt: string = new Date().toISOString(),
): FundTrailSnapshot {
  const toNode = (hn: HopNode): ExportFlowNode => ({
    groupLabel: hn.groupLabel,
    totalSats: hn.totalSats,
    isUnknown: hn.isUnknown,
    details: deduplicateDetails(hn.details),
    children: [],
    hopDepth: hn.hopDepth,
    pathAddresses: hn.pathAddresses,
  });

  const sources = result.sources.map(toNode);
  const destinations = result.destinations.map(toNode);

  // Aggregate cap info from the multi-hop cap entries
  const cappedEntries = result.caps.filter(c => c.isCapped);
  const cap: FundTrailCapInfo = {
    capped: cappedEntries.length > 0,
    shownTxCount: cappedEntries.reduce((s, c) => s + c.shownTxCount, 0),
    totalTxCount: cappedEntries.reduce((s, c) => s + c.totalTxCount, 0),
    cappedHopCount: cappedEntries.length,
  };

  return { centerLabel, dimension, generatedAt, sources, destinations, cap };
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
  // Collect every hop actually reached while assembling the tree (the center
  // hop plus any expanded hops the recursion pulled from the registry), so the
  // cap summary reflects exactly what the snapshot renders.
  const reachedHops: TrailHop[] = [centerHop];
  const sources = centerHop.sources.map((f) =>
    buildNode(
      f,
      flowPath("", "source", f.groupLabel),
      "source",
      expandedHops,
      reachedHops,
    ),
  );
  const destinations = centerHop.destinations.map((f) =>
    buildNode(
      f,
      flowPath("", "dest", f.groupLabel),
      "dest",
      expandedHops,
      reachedHops,
    ),
  );
  return {
    centerLabel,
    dimension,
    generatedAt,
    sources,
    destinations,
    cap: aggregateCapInfo(reachedHops),
  };
}

/**
 * Aggregate cap status across a set of hops. A hop counts toward the warning
 * only when isCapped=true; its shown/total transaction counts are summed so the
 * export can state how much of the trail is missing. De-dupes by reference so a
 * hop reached via multiple paths is counted once.
 */
function aggregateCapInfo(hops: TrailHop[]): FundTrailCapInfo {
  const seen = new Set<TrailHop>();
  let shownTxCount = 0;
  let totalTxCount = 0;
  let cappedHopCount = 0;
  for (const hop of hops) {
    if (seen.has(hop)) continue;
    seen.add(hop);
    if (!hop.isCapped) continue;
    cappedHopCount += 1;
    shownTxCount += hop.shownTxCount ?? 0;
    totalTxCount += hop.totalTxCount ?? 0;
  }
  return { capped: cappedHopCount > 0, shownTxCount, totalTxCount, cappedHopCount };
}

/**
 * Human-readable warning line describing how much of the trail is missing.
 * Returns null when nothing was capped. Shared by all export formats so the
 * wording stays consistent.
 */
export function capWarningText(cap: FundTrailCapInfo): string | null {
  if (!cap.capped) return null;
  const shown = cap.shownTxCount.toLocaleString();
  const total = cap.totalTxCount.toLocaleString();
  const hops =
    cap.cappedHopCount > 1 ? `${cap.cappedHopCount} hops were` : "a hop was";
  return (
    `WARNING: This Fund Trail is incomplete. Because ${hops} truncated for ` +
    `performance, only ${shown} of ${total} transactions are included. The ` +
    `exported fund flow does not represent the complete history.`
  );
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
  includeHopDepth: boolean,
): void {
  for (const d of node.details) {
    const row = [direction === "source" ? "incoming" : "outgoing", node.groupLabel];
    if (includeHopDepth) {
      // Multi-hop snapshots carry hop_depth plus the chain of unknown
      // intermediary addresses traversed to reach this node, so an auditor can
      // reconstruct the path. The chain is summarized (first N + "(+M more)")
      // for very long chains so the cell stays scannable; csvCell handles any
      // quoting needed for the combined value.
      row.push(String(node.hopDepth ?? 1));
      row.push(summarizeIntermediaryChain(node.pathAddresses ?? []));
    }
    row.push(btcAmount(d.amount), d.address, d.txid, isoDate(d.blockTime));
    rows.push(row);
  }
  for (const child of node.children) {
    collectCsvRows(child, direction, rows, includeHopDepth);
  }
}

/**
 * Build a CSV export of the Fund Trail snapshot. Columns: direction, group,
 * [hop_depth, intermediary_addresses,] amount_btc, address, txid, date. One row
 * per address flow, covering the center node's sources and destinations plus
 * every expanded hop. hop_depth and intermediary_addresses are included only
 * for multi-hop snapshots (where any node has hopDepth set) so the existing
 * single-hop CSV format is preserved. intermediary_addresses lists the chain of
 * unknown addresses traversed (joined with " > ") between the center and the
 * surfaced entity, so auditors can reconstruct the path.
 * Fully offline — no external resources.
 */
export function buildFundTrailCsv(snapshot: FundTrailSnapshot): string {
  const allNodes = [...snapshot.sources, ...snapshot.destinations];
  const includeHopDepth = allNodes.some(n => n.hopDepth != null);
  const headers = includeHopDepth
    ? ["direction", "group", "hop_depth", "intermediary_addresses", "amount_btc", "address", "txid", "date"]
    : ["direction", "group", "amount_btc", "address", "txid", "date"];
  const rows: string[][] = [];
  for (const node of snapshot.sources) {
    collectCsvRows(node, "source", rows, includeHopDepth);
  }
  for (const node of snapshot.destinations) {
    collectCsvRows(node, "destination", rows, includeHopDepth);
  }
  const lines = [headers, ...rows].map((cols) => cols.map(csvCell).join(","));
  // Prepend the cap warning as a comment line above the header when the trail
  // was truncated, so a reader sees the incompleteness without it corrupting
  // the columns. Uncapped exports are byte-for-byte unchanged.
  const warning = capWarningText(snapshot.cap);
  if (warning) {
    lines.unshift(`# ${csvCell(warning)}`);
  }
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

/**
 * Sum the totals for a side (center hop in/out).
 *
 * For single-hop snapshots all nodes are direct flows (`hopDepth` is
 * undefined) and all are summed. For multi-hop snapshots, only hop-1 nodes
 * represent actual direct flows; deeper nodes are upstream/downstream chain
 * segments of the same funds. Summing across all depths would double-count,
 * so we restrict to `hopDepth === 1` (or `hopDepth == null` for single-hop).
 */
export function sumTopLevel(nodes: ExportFlowNode[]): number {
  const isMultiHop = nodes.some(n => n.hopDepth != null);
  return nodes
    .filter(n => !isMultiHop || n.hopDepth === 1)
    .reduce((s, n) => s + n.totalSats, 0);
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

  // When the trail was truncated, render a prominent warning banner before the
  // sections so anyone reading (or sharing) the PDF knows the flow is partial.
  const warning = capWarningText(snapshot.cap);
  if (warning) {
    const warnMaxWidth = pageWidth - 28;
    const warnLines = doc.splitTextToSize(warning, warnMaxWidth);
    const warnHeight = doc.getTextDimensions(warnLines).h;
    const boxTop = cursorY - 4;
    const boxHeight = warnHeight + 6;
    doc.setFillColor(255, 243, 205); // soft amber background
    doc.setDrawColor(214, 158, 46); // amber border
    doc.rect(14, boxTop, pageWidth - 28, boxHeight, "FD");
    doc.setFontSize(9);
    doc.setTextColor(133, 100, 4);
    doc.text(warnLines, 16, cursorY);
    doc.setTextColor(0);
    cursorY = boxTop + boxHeight + 6;
  }

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
    const body = flat.map(({ depth, node }) => {
      const hopPrefix = node.hopDepth != null ? `Hop ${node.hopDepth}: ` : "";
      const indentPrefix = `${"    ".repeat(depth)}${depth > 0 ? "↳ " : ""}`;
      // Show the chain of unknown intermediary addresses inline beneath the hop
      // group label so an auditor can trace through which addresses the entity
      // was reached. Wraps within the cell (overflow: linebreak below).
      const path = node.pathAddresses ?? [];
      const pathLine =
        path.length > 0
          ? `\n${indentPrefix}    via: ${summarizeIntermediaryChain(path)}`
          : "";
      return [
        `${indentPrefix}${hopPrefix}${node.groupLabel}${pathLine}`,
        formatBtc(node.totalSats),
        String(node.details.length),
      ];
    });

    autoTable(doc, {
      startY: cursorY,
      head: [["Group", "Amount", "Addresses"]],
      body,
      styles: { fontSize: 8, cellPadding: 1.5, overflow: "linebreak" },
      headStyles: { fillColor: [41, 128, 185] },
      columnStyles: {
        0: { cellWidth: 120 },
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

    doc.setFontSize(9);
    const prefix = depth > 0 ? "↳ " : "";
    // Wrap the heading the same way the detail columns wrap, so a long group
    // label (e.g. a descriptor-derived name) breaks onto extra lines instead of
    // being pushed off the right page edge.
    const headingText = `${prefix}${node.groupLabel} — ${formatBtc(node.totalSats)}`;
    const headingMaxWidth = pageWidth - 16 - 14;
    const headingLines = doc.splitTextToSize(headingText, headingMaxWidth);
    const oneLineHeight = doc.getTextDimensions("X").h;
    const headingHeight = doc.getTextDimensions(headingLines).h;
    ensureSpace(headingHeight + 8);
    doc.setTextColor(60);
    doc.text(headingLines, 16, cursorY);
    doc.setTextColor(0);
    cursorY += headingHeight - oneLineHeight + 2;

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

  renderSection("Incoming — received from", snapshot.sources, "No incoming transactions found.");
  renderSection("Outgoing — sent to", snapshot.destinations, "No outgoing transactions found.");

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
