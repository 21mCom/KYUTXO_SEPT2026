/**
 * Shared presentational helpers for the Fund Trail layout variants.
 */

import { Wallet, User, KeyRound, HelpCircle, AlertTriangle } from "lucide-react";
import type { MultiHopCapEntry } from "@/lib/data/fund-trail-engine";
import type { Direction } from "./view-data";

export function dimIcon(dim: string, className = "w-3 h-3") {
  if (dim === "walletName") return <Wallet className={className} />;
  if (dim === "owner") return <User className={className} />;
  if (dim === "seedName") return <KeyRound className={className} />;
  return <HelpCircle className={className} />;
}

export function roleColor(
  direction: Direction | "center",
  isUnknown: boolean,
): string {
  if (direction === "center") return "var(--ft-accent)";
  if (isUnknown) return "var(--ft-unknown)";
  return direction === "source" ? "var(--ft-source)" : "var(--ft-dest)";
}

export function roleSoftColor(
  direction: Direction | "center",
  isUnknown: boolean,
): string {
  if (direction === "center") return "var(--ft-accent-soft)";
  if (isUnknown) return "var(--ft-unknown-soft)";
  return direction === "source" ? "var(--ft-source-soft)" : "var(--ft-dest-soft)";
}

/**
 * Renders hop-level cap notices. Caps come from the engine per (depth,
 * direction); they are NOT per node, so this lists the affected hops honestly
 * rather than badging individual nodes.
 */
export function HopCapNotice({
  caps,
  className,
}: {
  caps: MultiHopCapEntry[];
  className?: string;
}) {
  const capped = caps.filter((c) => c.isCapped);
  if (capped.length === 0) return null;
  return (
    <div
      className={`flex flex-col gap-1.5 ${className ?? ""}`}
      data-testid="ft-cap-notice"
    >
      {capped.map((c) => (
        <div
          key={`${c.direction}-${c.depth}`}
          className="flex items-start gap-2 text-[11px] text-[var(--ft-warn)] bg-[var(--ft-warn-soft)] border border-[var(--ft-warn)]/20 px-2.5 py-1.5 rounded-md"
        >
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
          <span>
            Hop {c.depth}{" "}
            {c.direction === "source" ? "sources" : "destinations"} — showing{" "}
            {c.shownTxCount.toLocaleString()} of{" "}
            {c.totalTxCount.toLocaleString()} txns
          </span>
        </div>
      ))}
    </div>
  );
}

/** A single-hop inline cap banner used inside per-column layouts. */
export function ColumnCapBanner({ cap }: { cap?: MultiHopCapEntry }) {
  if (!cap || !cap.isCapped) return null;
  return (
    <div
      className="bg-[var(--ft-warn-soft)] text-[var(--ft-warn)] text-[10px] px-3 py-1.5 flex items-center gap-1.5 border border-[var(--ft-warn)]/20 rounded-md mb-3"
      data-testid="ft-cap-banner"
    >
      <AlertTriangle className="w-3 h-3 shrink-0" />
      <span>
        Showing {cap.shownTxCount.toLocaleString()} of{" "}
        {cap.totalTxCount.toLocaleString()} txns
      </span>
    </div>
  );
}
